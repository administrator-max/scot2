// ==========================================
// 1. STATE & UTILITIES
// ==========================================
let D = []; // Source of truth: fetched from PostgreSQL
const T = new Date().toISOString().substring(0, 10);
let LU = T;
let aiR = null; 
let it, ogI, dnI, ctI, bkI;

const VF = {
  "HPC ATLANTIC": "https://www.vesselfinder.com/vessels/details/9667899",
  "JIN HAI PING": "https://www.vesselfinder.com/vessels/details/9591040",
  "MARSA PRIDE": "https://www.vesselfinder.com/vessels/details/9301445",
  "OSCAR": "https://www.vesselfinder.com/vessels/details/9545510",
  "MSC VOYAGER III": "https://www.vesselfinder.com/vessels/details/7820916",
  "MSC VOYAGER": "https://www.vesselfinder.com/vessels/details/7820916"
};

const IS = [
  {id:-2, i:"📝", l:"Contract"}, {id:-1, i:"📌", l:"Booked"}, {id:0, i:"📦", l:"Load"}, 
  {id:1, i:"🚢", l:"Sail"}, {id:2, i:"⚓", l:"Port"}, {id:3, i:"📋", l:"Customs"}, 
  {id:4, i:"🏗️", l:"Unload"}, {id:45, i:"🚚", l:"in Transit"}, {id:5, i:"🚛", l:"Deliver"}, {id:6, i:"🏭", l:"WH"}
];

const DS = [
  {id:-2, i:"📝", l:"Contract"}, {id:-1, i:"📌", l:"Booked"}, {id:4, i:"📦", l:"Ready"}, 
  {id:45, i:"🚚", l:"in Transit"}, {id:5, i:"🚛", l:"Deliver"}, {id:6, i:"🏭", l:"WH"}
];

function vfUrl(vn) {
  const n = (vn || "").replace("MV ", "").trim().toUpperCase();
  return VF[n] || "https://www.vesselfinder.com/vessels?name=" + encodeURIComponent(n);
}

function formatDateForFrontend(dObj) {
  const dateFields = ['etd', 'eta', 'pib_billing', 'bpn', 'spjm', 'behandle', 'sppb', 'start_unloading', 'finish_unloading', 'start_delivery', 'enter_warehouse'];
  const numericFields = ['quantity_mt', 'est_sailing_days', 'actual_sailing_days', 'clearance_days', 'unloading_days', 'delivery_days', 'no', 'year'];

  const formatted = { ...dObj };
  
  // 1. Format Postgres Dates safely
  dateFields.forEach(field => {
    if (formatted[field] && typeof formatted[field] === 'string') {
      formatted[field] = formatted[field].substring(0, 10);
    }
  });

  // 2. Parse Strings into Numbers (Fixes PostgreSQL NUMERIC concatenation bugs)
  numericFields.forEach(field => {
    if (formatted[field] != null && formatted[field] !== '') {
      formatted[field] = parseFloat(formatted[field]);
    } else {
      formatted[field] = null;
    }
  });

  return formatted;
}

function gp(d) {
  if (d.status === "Contract") return {s:-2, l:"Contract", u:""};
  if (d.status === "Booked") return {s:-1, l:"Booked", u:""};
  if (d.status === "On Going" && d.remarks && d.remarks.toLowerCase().includes("awaiting")) return {s:45, l:"in Transit", u:d.remarks};
  
  if (d.cargo_type === "Domestic") {
    if (d.enter_warehouse) return {s:6, l:"At Warehouse", u:d.warehouse_location || ""};
    if (d.start_delivery && !d.enter_warehouse) return {s:45, l:"In Transit", u:""};
    return {s:4, l:"Waiting", u:""};
  }
  
  if (d.status === "Done" && d.warehouse_location) return {s:6, l:"At Warehouse", u:d.warehouse_location};
  if (d.enter_warehouse) return {s:6, l:"At Warehouse", u:d.warehouse_location || ""};
  if (d.start_delivery && !d.enter_warehouse) return {s:45, l:"In Transit", u:""};
  if (d.finish_unloading) return {s:4, l:"Unloaded", u:""};
  if (d.start_unloading) return {s:4, l:"Unloading", u:""};
  if (d.sppb) return {s:3, l:"Cleared", u:""};
  if (d.pib_billing) return {s:3, l:"Customs", u:""};
  if (d.eta && T >= d.eta) return {s:2, l:"At Port", u:d.pod || ""};
  if (d.etd && T >= d.etd) return {s:1, l:"Sailing", u:""};
  return {s:0, l:"Awaiting", u:""};
}

function gd(d) {
  const dl = [];
  if (d.est_sailing_days != null && d.actual_sailing_days != null && d.actual_sailing_days > d.est_sailing_days + 2) {
    dl.push({t:"Sailing", d: "+" + Math.round(d.actual_sailing_days - d.est_sailing_days) + "d"});
  }
  if (d.clearance_days != null && d.clearance_days > 3) {
    dl.push({t:"Customs", d: d.clearance_days + "d"});
  }
  if (d.unloading_days != null && d.unloading_days > 3) {
    dl.push({t:"Unload", d: d.unloading_days + "d"});
  }
  return dl;
}

function gm(d) {
  const r = d.cargo_type === "Import" ? (d.eta || d.etd) : d.start_delivery;
  return r ? r.substring(0, 7) : null;
}

function fD(d) {
  if (!d || d === "-") return "-";
  return new Date(d).toLocaleDateString("en-GB", {day:"numeric", month:"short", year:"numeric"});
}

function fN(n) {
  if (n == null || isNaN(n)) return "-";
  return Number(n).toLocaleString("en-US", {maximumFractionDigits:1});
}

function mN(ym) {
  if (!ym) return "-";
  const [y, m] = ym.split("-");
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m] + " " + y;
}

function sc(d) {
  if (d.status === "Contract") return "ct";
  if (d.status === "Booked") return "bk";
  if (d.status === "On Going" && d._p.s === 45) return "it";
  if (d.status === "On Going") return "og";
  if (d._p.s === 6) return "wh";
  if (d._p.s >= 3) return "cust";
  return "sail";
}

function ref() {
  it = D.map(d => ({...d, _id: d.id, _p: gp(d), _d: gd(d), _m: gm(d)}));
  ogI = it.filter(d => d.status === "On Going");
  dnI = it.filter(d => d.status === "Done");
  ctI = it.filter(d => d.status === "Contract");
  bkI = it.filter(d => d.status === "Booked");
  document.getElementById("og-c").textContent = ogI.length;
  document.getElementById("dn-c").textContent = dnI.length;
}

function updLU() {
  const now = new Date();
  LU = now.toISOString().substring(0, 10);
  const h2 = String(now.getHours()).padStart(2, '0');
  const m2 = String(now.getMinutes()).padStart(2, '0');
  const luStr = `${fD(LU)} ${h2}:${m2}`;
  
  const tdEl = document.getElementById('td');
  if (tdEl) {
    tdEl.innerHTML = `Today: ${fD(T)} &nbsp;&middot;&nbsp; <span style="font-weight:600">Last Update: <span id="lu-date">${luStr}</span></span>`;
  }
}

function tst(msg, type) {
  const t = document.createElement("div");
  t.className = `tst ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}