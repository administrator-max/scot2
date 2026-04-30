-- Run this in your PostgreSQL database to create the table
CREATE TABLE IF NOT EXISTS shipments (
    id SERIAL PRIMARY KEY,
    no INTEGER,
    cargo_type VARCHAR(50),
    consignee VARCHAR(255),
    project_name VARCHAR(255) NOT NULL,
    product VARCHAR(255),
    quantity_mt NUMERIC,
    bl_number VARCHAR(255),
    shipping_line VARCHAR(255),
    vessel_name VARCHAR(255),
    voyage_number VARCHAR(255),
    pol VARCHAR(255),
    pod VARCHAR(255),
    shipment_route VARCHAR(50),
    etd DATE,
    eta DATE,
    shipment_type VARCHAR(50),
    est_sailing_days NUMERIC,
    actual_sailing_days NUMERIC,
    pib_billing DATE,
    bpn DATE,
    spjm DATE,
    behandle DATE,
    sppb DATE,
    clearance_days NUMERIC,
    start_unloading DATE,
    finish_unloading DATE,
    unloading_days NUMERIC,
    cargo_status VARCHAR(50),
    start_delivery DATE,
    enter_warehouse DATE,
    delivery_days NUMERIC,
    vendor_trucking VARCHAR(255),
    warehouse_location VARCHAR(255),
    status VARCHAR(50),
    remarks TEXT,
    year INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Auto-update updated_at on every UPDATE
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shipments_set_updated_at ON shipments;
CREATE TRIGGER shipments_set_updated_at
    BEFORE UPDATE ON shipments
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Case-insensitive uniqueness on (project_name, cargo_type, bl_number) — matches the
-- frontend dedup logic which trims and lowercases project_name before comparing.
DROP INDEX IF EXISTS idx_shipment_unique;
CREATE UNIQUE INDEX idx_shipment_unique
    ON shipments (LOWER(TRIM(project_name)), cargo_type, COALESCE(LOWER(bl_number), ''));

-- Indexes to speed up dashboard queries / future filtered server-side reads
CREATE INDEX IF NOT EXISTS idx_shipments_status       ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_year         ON shipments(year);
CREATE INDEX IF NOT EXISTS idx_shipments_consignee    ON shipments(consignee);
CREATE INDEX IF NOT EXISTS idx_shipments_cargo_type   ON shipments(cargo_type);
CREATE INDEX IF NOT EXISTS idx_shipments_eta          ON shipments(eta);
CREATE INDEX IF NOT EXISTS idx_shipments_etd          ON shipments(etd);
CREATE INDEX IF NOT EXISTS idx_shipments_year_id_desc ON shipments(year DESC, id DESC);
