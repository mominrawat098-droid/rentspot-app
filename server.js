// server.js
require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const { initSchema, run, get } = require("./database");

const app = express();

// Render/Proxy safe
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // Render uses https but proxy; keep false for simplicity
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// Views/static
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Helpers
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

// Home
app.get("/", (req, res) => {
  // If you have index.ejs, render it, else simple message
  try {
    return res.render("index", { user: req.session.user || null });
  } catch (e) {
    return res.send("RentSpot is running ✅");
  }
});

// Register page
app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

// Register submit
app.post("/register", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";

    if (!name || !email || !password) {
      return res.status(400).render("register", { error: "All fields required" });
    }

    const existing = await get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) {
      return res.status(400).render("register", { error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await run(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [name, email, passwordHash, "user"]
    );

    return res.redirect("/login");
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).render("register", { error: "Server error" });
  }
});

// Login page
app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

// Login submit
app.post("/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";

    const user = await get("SELECT id, name, email, password_hash, role FROM users WHERE email = ?", [email]);
    if (!user || !user.password_hash) {
      return res.status(401).render("login", { error: "Invalid email or password" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).render("login", { error: "Invalid email or password" });
    }

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    return res.redirect("/");
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).render("login", { error: "Server error" });
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Global error handler (very useful)
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);
  res.status(500).send("Internal Server Error");
});

// Start
const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log("Server running on port", PORT));
  })
  .catch((e) => {
    console.error("DB INIT FAILED:", e);
    process.exit(1);
  });