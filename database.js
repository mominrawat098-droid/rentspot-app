const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./rentspot.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'Pending'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    contact_phone TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    property_id INTEGER NOT NULL,
    stars INTEGER NOT NULL,
    comment TEXT,
    UNIQUE(user_id, property_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    property_id INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    persons INTEGER NOT NULL DEFAULT 1,
    checkin_date TEXT NOT NULL,
    checkout_date TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    approval_status TEXT DEFAULT 'Pending',
    payment_status TEXT DEFAULT 'Pending',
    payment_method TEXT,
    transaction_id TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    upi_id TEXT,
    qr_image TEXT
  )`);

  db.get("SELECT id FROM settings WHERE id=1", (err, row) => {
    if (!row) db.run("INSERT INTO settings (id, upi_id, qr_image) VALUES (1,'','')");
  });

  db.get("SELECT id FROM users WHERE email=?", ["admin@gmail.com"], (err, row) => {
    if (!row) {
      db.run(
        "INSERT INTO users (name,email,password,role,status) VALUES (?,?,?,?,?)",
        ["Admin", "admin@gmail.com", "1234", "admin", "Approved"]
      );
    }
  });
});

module.exports = db;