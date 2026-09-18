// ─── IndexedDB schema (one physical DB per cashier profile) ───────────────────
// Legacy single-store name remains `OfflinePOS` for profile id `default`.
// Additional profiles use `OfflinePOS__{profileId}`.

function openOfflineProfileDb(profileId) {
    const raw = String(profileId || 'default').trim();
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '');
    const id = safe || 'default';
    const dbName = id === 'default' ? 'OfflinePOS' : `OfflinePOS__${id}`;
    const db = new Dexie(dbName);

    db.version(4).stores({
        products:     'id, sku, barcode, name, category_id, brand_id',
        customers:    'id, name, phone',
        transactions: '++id, local_uuid, invoice_no, sync_status, created_at',
        held_sales:   '++id, held_at',
        settings:     'key',
    });

    db.version(5).stores({
        products:     'id, sku, barcode, name, category_id, brand_id',
        customers:    'id, name, phone',
        transactions: '++id, local_uuid, invoice_no, sync_status, created_at, status',
        held_sales:   '++id, held_at',
        settings:     'key',
    });

    db.version(6).stores({
        products:     'id, sku, barcode, name, category_id, brand_id',
        customers:    'id, name, phone, cloud_contact_id, local_customer_uuid',
        transactions: '++id, local_uuid, invoice_no, sync_status, created_at, status',
        held_sales:   '++id, held_at',
        settings:     'key',
        pending_customers: 'local_customer_uuid, mobile, cloud_contact_id',
    });

    db.version(7).stores({
        products:     'id, sku, barcode, name, category_id, brand_id',
        customers:    'id, name, phone, cloud_contact_id, local_customer_uuid',
        transactions: '++id, local_uuid, invoice_no, sync_status, created_at, status',
        held_sales:   '++id, held_at',
        settings:     'key',
        pending_customers: 'local_customer_uuid, mobile, cloud_contact_id',
    }).upgrade((tx) =>
        tx.pending_customers.toCollection().modify((row) => {
            if (row.address && !row.address_line_1) row.address_line_1 = row.address;
            if (!row.contact_kind) row.contact_kind = 'individual';
        }),
    );

    return db;
}
