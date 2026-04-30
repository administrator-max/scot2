// ==========================================
// 4. FORMS & EXCEL UPLOAD/EXPORT
// ==========================================
const FLDS = [
  {k:"cargo_type",l:"Cargo Type",t:"sel",o:["Import","Domestic"]},{k:"consignee",l:"Consignee",t:"txt"},
  {k:"project_name",l:"Project Name",t:"txt"},{k:"product",l:"Product",t:"txt"},
  {k:"quantity_mt",l:"Quantity (MT)",t:"num"},{k:"bl_number",l:"BL Number",t:"txt"},
  {k:"shipping_line",l:"Shipping Line",t:"txt"},{k:"vessel_name",l:"Vessel Name",t:"txt"},
  {k:"voyage_number",l:"Voyage Number",t:"txt"},{k:"pol",l:"Port of Loading",t:"txt"},
  {k:"pod",l:"Port of Discharge",t:"txt"},{k:"shipment_route",l:"Shipment Route",t:"sel",o:["Direct","Transit"]},
  {k:"etd",l:"ETD",t:"date"},{k:"eta",l:"ETA",t:"date"},
  {k:"shipment_type",l:"Shipment Type",t:"sel",o:["Breakbulk","Container"]},
  {k:"est_sailing_days",l:"Est Sailing (days)",t:"num"},{k:"actual_sailing_days",l:"Act Sailing (days)",t:"num"},
  {k:"pib_billing",l:"PIB Billing",t:"date"},{k:"bpn",l:"BPN",t:"date"},
  {k:"spjm",l:"SPJM",t:"date"},{k:"behandle",l:"Behandle",t:"date"},
  {k:"sppb",l:"SPPB",t:"date"},{k:"clearance_days",l:"Clearance (days)",t:"num"},
  {k:"start_unloading",l:"Start Unloading",t:"date"},{k:"finish_unloading",l:"Finish Unloading",t:"date"},
  {k:"unloading_days",l:"Unloading (days)",t:"num"},{k:"cargo_status",l:"Cargo Status",t:"sel",o:["Direct","Via Warehouse","Storage"]},
  {k:"start_delivery",l:"Start Delivery",t:"date"},{k:"enter_warehouse",l:"Enter Warehouse",t:"date"},
  {k:"delivery_days",l:"Delivery (days)",t:"num"},{k:"vendor_trucking",l:"Vendor Trucking",t:"txt"},
  {k:"warehouse_location",l:"Warehouse Location",t:"txt"},{k:"status",l:"Status",t:"sel",o:["Contract","Booked","On Going","Done"]},
  {k:"remarks",l:"Remarks",t:"txt"}
];

function mkInput(f, val) {
  const v = val || "";
  if (f.t === "sel") {
    const opts = f.o.map(o => `<option value="${o}" ${v === o ? 'selected' : ''}>${o}</option>`).join("");
    return `<select class="sbox" data-fk="${f.k}" style="width:100%;padding:7px 10px"><option value="">-</option>${opts}</select>`;
  }
  if (f.t === "date") return `<input type="date" class="sbox" data-fk="${f.k}" value="${v}" style="width:100%;padding:7px 10px">`;
  if (f.t === "num") return `<input type="number" step="any" class="sbox" data-fk="${f.k}" value="${v}" style="width:100%;padding:7px 10px">`;
  return `<input type="text" class="sbox" data-fk="${f.k}" value="${v}" style="width:100%;padding:7px 10px">`;
}

function mkField(f, val) {
  return `<div style="margin-bottom:6px">
    <label style="font-size:10px;font-weight:600;color:var(--muted);display:block;margin-bottom:2px">${f.l}</label>
    ${mkInput(f, val)}
  </div>`;
}

document.getElementById('tab-upd-og').addEventListener('click', () => {
  document.getElementById('frm-og').classList.toggle('hid');
  document.getElementById('frm-new').classList.add('hid');
  document.getElementById('sec-upl').classList.add('hid');
  const sel = document.getElementById('sel-og');
  sel.innerHTML = '<option value="">-- Select --</option>';
  it.filter(d => d.status !== 'Done').forEach(d => {
    sel.innerHTML += `<option value="${d._id}">${d.project_name} (${d.product}) [${d.status}]</option>`;
  });
  document.getElementById('frm-og-fields').innerHTML = '';
});

document.getElementById('tab-upd-new').addEventListener('click', () => {
  document.getElementById('frm-new').classList.toggle('hid');
  document.getElementById('frm-og').classList.add('hid');
  document.getElementById('sec-upl').classList.add('hid');
  document.getElementById('frm-new-fields').innerHTML = FLDS.map(f => mkField(f, '')).join('');
});

document.getElementById('tab-upl').addEventListener('click', () => {
  document.getElementById('sec-upl').classList.toggle('hid');
  document.getElementById('frm-og').classList.add('hid');
  document.getElementById('frm-new').classList.add('hid');
});

document.getElementById('sel-og').addEventListener('change', function() {
  const id = +this.value;
  const d = it.find(x => x._id === id);
  if (!d) { document.getElementById('frm-og-fields').innerHTML = ''; return; }
  
  const html = FLDS.map(f => {
    let val = d[f.k];
    if (val == null) val = '';
    if (f.t === 'num' && val) val = String(val);
    return mkField(f, String(val));
  }).join('');
  
  document.getElementById('frm-og-fields').innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${html}</div>`;
});

document.getElementById('btn-upd-og').addEventListener('click', async function() {
  const id = +document.getElementById('sel-og').value;
  if (!id && id !== 0) { tst('Select a shipment first', 'er'); return; }
  
  const updates = {};
  document.querySelectorAll('#frm-og-fields [data-fk]').forEach(el => {
    const k = el.dataset.fk, v = el.value;
    if (!v || v === '-') updates[k] = null;
    else if (el.type === 'number') updates[k] = parseFloat(v) || null;
    else updates[k] = v;
  });

  const btn = document.getElementById('btn-upd-og');
  btn.disabled = true;
  
  try {
    const res = await fetch(`/api/shipments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (res.ok) {
      const row = await res.json();
      document.getElementById('frm-og').classList.add('hid');
      tst('Shipment updated in database', 'ok');
      patchLocal(row);
    } else throw new Error('Update Failed');
  } catch(e) { tst('Failed to update: ' + e.message, 'er'); }
  finally { btn.disabled = false; }
});

document.getElementById('btn-can-og').addEventListener('click', () => document.getElementById('frm-og').classList.add('hid'));

document.getElementById('btn-add-new').addEventListener('click', async function() {
  const rec = {};
  let hasName = false;
  
  document.querySelectorAll('#frm-new-fields [data-fk]').forEach(el => {
    const k = el.dataset.fk, v = el.value;
    if (k === 'project_name' && v) hasName = true;
    if (!v || v === '-') return;
    if (el.type === 'number') rec[k] = parseFloat(v) || null;
    else rec[k] = v;
  });
  
  if (!hasName) { tst('Project Name is required', 'er'); return; }
  
  rec.no = D.length ? Math.max(...D.map(d => d.no || 0)) + 1 : 1;
  const rf = rec.eta || rec.etd || rec.start_delivery;
  rec.year = rf ? parseInt(rf.substring(0,4)) : new Date().getFullYear();
  if (!rec.status) rec.status = 'On Going';
  
  const btn = document.getElementById('btn-add-new');
  btn.disabled = true;

  try {
    const res = await fetch('/api/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec)
    });
    if (res.ok) {
      const row = await res.json();
      document.getElementById('frm-new').classList.add('hid');
      tst('New shipment saved to database', 'ok');
      patchLocal(row, true);
    } else throw new Error('Save failed');
  } catch(e) { tst('Failed to save new shipment', 'er'); }
  finally { btn.disabled = false; }
});

document.getElementById('btn-can-new').addEventListener('click', () => document.getElementById('frm-new').classList.add('hid'));

document.getElementById('tab-exp').addEventListener('click', () => {
  const hdrs = ['No','Cargo Type','Consignee','Project Name','Product','Quantity (MT)','BL Number','Shipping Line','Vessel Name','Voyage Number','POL','POD','Shipment Route','ETD','ETA','Shipment Type','Est Sailing (Day)','Act Sailing (Day)','PIB Billing','BPN','SPJM','Behandle','SPPB','Clearance (Day)','Start Unloading','Finish Unloading','Unloading (Day)','Cargo Status','Start Delivery','Enter Warehouse','Delivery (Day)','Vendor Trucking','Warehouse Location','Status','Remarks'];
  const keys = ['no','cargo_type','consignee','project_name','product','quantity_mt','bl_number','shipping_line','vessel_name','voyage_number','pol','pod','shipment_route','etd','eta','shipment_type','est_sailing_days','actual_sailing_days','pib_billing','bpn','spjm','behandle','sppb','clearance_days','start_unloading','finish_unloading','unloading_days','cargo_status','start_delivery','enter_warehouse','delivery_days','vendor_trucking','warehouse_location','status','remarks'];
  
  const wb = XLSX.utils.book_new();
  const wsData = [hdrs];
  
  D.forEach((d, i) => {
    wsData.push(keys.map(k => {
      if (k === 'no') return i + 1;
      return d[k] != null ? d[k] : '';
    }));
  });
  
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = hdrs.map((h, i) => {
    if (i === 2 || i === 3) return {wch:25};
    if (i === 5 || i === 7) return {wch:20};
    if (i === 9 || i === 10 || i === 31) return {wch:20};
    if (i === 0 || i >= 15 && i <= 25) return {wch:12};
    return {wch:16};
  });
  
  XLSX.utils.book_append_sheet(wb, ws, 'Shipment Database');
  XLSX.writeFile(wb, `SCOT_Database_${LU}.xlsx`);
  tst(`Excel exported: SCOT_Database_${LU}.xlsx`, 'ok');
});

// Bulk Upload Logic
const uz = document.getElementById("uz"), fi = document.getElementById("fi");
uz.addEventListener("click", () => fi.click());
uz.addEventListener("dragover", e => { e.preventDefault(); uz.classList.add("ov"); });
uz.addEventListener("dragleave", () => uz.classList.remove("ov"));
uz.addEventListener("drop", e => { e.preventDefault(); uz.classList.remove("ov"); if(e.dataTransfer.files.length) pF(e.dataTransfer.files[0]); });
fi.addEventListener("change", e => { if(e.target.files.length) pF(e.target.files[0]); });

function eD2(v) { 
  if (!v) return null; 
  if (typeof v === "string") { 
    if (v === "-") return null; 
    if (v.match(/^\d{4}-\d{2}-\d{2}/)) return v.substring(0,10); 
    return v; 
  } 
  if (typeof v === "number" && v > 40000) return new Date((v - 25569) * 864e5).toISOString().substring(0,10); 
  return v; 
}

function pR(row) { 
  const r = {}; 
  const fields = ['no','cargo_type','consignee','project_name','product','quantity_mt','bl_number','shipping_line','vessel_name','voyage_number','pol','pod','shipment_route','etd','eta','shipment_type','est_sailing_days','actual_sailing_days','pib_billing','bpn','spjm','behandle','sppb','clearance_days','start_unloading','finish_unloading','unloading_days','cargo_status','start_delivery','enter_warehouse','delivery_days','vendor_trucking','warehouse_location','status','remarks'];
  fields.forEach((k, i) => { 
    let v = row[i]; 
    if (v == null || v === "-" || v === "") { r[k] = null; return; } 
    if (['etd','eta','pib_billing','bpn','spjm','behandle','sppb','start_unloading','finish_unloading','start_delivery','enter_warehouse'].includes(k)) r[k] = eD2(v); 
    else if (['no','quantity_mt','est_sailing_days','actual_sailing_days','clearance_days','unloading_days','delivery_days'].includes(k)) r[k] = typeof v === "number" ? v : parseFloat(v) || null; 
    else r[k] = String(v).trim(); 
  }); 
  return r; 
}

function fM(r) { 
  return D.findIndex(d => d.project_name && r.project_name && d.project_name.trim().toLowerCase() === r.project_name.trim().toLowerCase() && d.cargo_type === r.cargo_type && (d.bl_number||"") === (r.bl_number||"")); 
}

let pnd = null;
function pF(file) {
  if (!file.name.match(/\.xlsx?$/i)) { tst("Format must be .xlsx", "er"); return; }
  const rd = new FileReader();
  rd.onload = function(e) {
    try {
      const wb = XLSX.read(e.target.result, {type:"array", cellDates:true});
      const nw = [], up = [], sk = [];
      wb.SheetNames.forEach(sn => {
        if (!sn.toLowerCase().includes("analyze")) return;
        const ws = wb.Sheets[sn];
        const j = XLSX.utils.sheet_to_json(ws, {header:1, raw:false, dateNF:"yyyy-mm-dd"});
        let sr = 0;
        for (let i=0; i < Math.min(5, j.length); i++) { if (String(j[i]?.[0]||"").toLowerCase().startsWith("no")) { sr = i + 1; break; } }
        
        for (let i = sr; i < j.length; i++) {
          const row = j[i];
          if (!row || !row[0] || String(row[0]).toLowerCase() === "no.") continue;
          const rec = pR(row);
          if (!rec.project_name) continue;
          
          const rf = rec.eta || rec.etd || rec.start_delivery;
          rec.year = rf ? parseInt(rf.substring(0,4)) : new Date().getFullYear();
          const mi = fM(rec);
          
          if (mi >= 0) {
            let ch = false;
            const fields = ['no','cargo_type','consignee','project_name','product','quantity_mt','bl_number','shipping_line','vessel_name','voyage_number','pol','pod','shipment_route','etd','eta','shipment_type','est_sailing_days','actual_sailing_days','pib_billing','bpn','spjm','behandle','sppb','clearance_days','start_unloading','finish_unloading','unloading_days','cargo_status','start_delivery','enter_warehouse','delivery_days','vendor_trucking','warehouse_location','status','remarks'];
            fields.forEach(k => {
              if (k === "no") return;
              if ((rec[k] || "") !== (D[mi][k] || "") && !(rec[k] == null && D[mi][k] == null)) ch = true;
            });
            if (ch) up.push({rec, mi}); else sk.push(rec);
          } else nw.push(rec);
        }
      });
      pnd = {nw, up, sk};
      sPv(nw, up, sk);
    } catch(err) { tst("Failed: " + err.message, "er"); }
  };
  rd.readAsArrayBuffer(file);
}

function sPv(nw, up, sk) {
  const el = document.getElementById("ur");
  el.innerHTML = `<div class="upl-r">
    <h4 style="font-size:14px;font-weight:700;margin-bottom:10px">Parse Results</h4>
    <div class="upl-s">
      <div class="upl-ch nw">🆕 ${nw.length} New</div>
      <div class="upl-ch up">🔄 ${up.length} Updates</div>
      <div class="upl-ch sk">⏭️ ${sk.length} Unchanged</div>
    </div>
    ${(nw.length || up.length) ? `
      <table class="upl-tb">
        <tr><th></th><th>Project</th><th>Product</th><th>Qty</th><th>Status</th><th>Action</th></tr>
        ${nw.map(r => `<tr><td>🆕</td><td>${r.project_name}</td><td>${r.product||"-"}</td><td>${fN(r.quantity_mt)}</td><td>${r.status||"-"}</td><td style="color:var(--grn);font-weight:700">Add</td></tr>`).join("")}
        ${up.map(u => `<tr><td>🔄</td><td>${u.rec.project_name}</td><td>${u.rec.product||"-"}</td><td>${fN(u.rec.quantity_mt)}</td><td>${u.rec.status||"-"}</td><td style="color:var(--pri);font-weight:700">Update</td></tr>`).join("")}
      </table>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="abtn" id="ba">Apply ${nw.length + up.length} Changes</button>
        <button class="cbtn" id="bc">Cancel</button>
      </div>` 
    : `<p style="color:var(--muted);font-size:12px">No changes detected.</p><button class="cbtn" id="bc" style="margin-top:10px">OK</button>`}
  </div>`;
  
  document.getElementById("bc")?.addEventListener("click", () => { el.innerHTML=""; pnd=null; fi.value=""; });
  document.getElementById("ba")?.addEventListener("click", aC);
}

async function aC() {
  if (!pnd) return;
  const btn = document.getElementById("ba");
  btn.innerText = "Applying...";
  btn.disabled = true;

  const payload = {
    updates: pnd.up.map(x => ({ id: D[x.mi].id || D[x.mi]._id, data: x.rec })),
    inserts: pnd.nw
  };

  try {
    const res = await fetch('/api/shipments/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      tst(`✅ ${pnd.nw.length} added, ${pnd.up.length} updated`, "ok");
      document.getElementById("ur").innerHTML = "";
      pnd = null;
      fi.value = "";
      await fetchShipments(); // Fetches fresh data
    } else throw new Error("Server Error");
  } catch (error) {
    tst("Failed to save changes", "er");
    btn.innerText = "Apply Changes";
    btn.disabled = false;
  }
}