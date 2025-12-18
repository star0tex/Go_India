// src/middlewares/adminAuth.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

console.log("🔐 adminAuth middleware loaded");

/**
 * @desc    Verify admin JWT token
 * @usage   Use this middleware on admin-only routes
 * @example router.get('/admin/dashboard', verifyAdminToken, getDashboardStats);
 */
export const verifyAdminToken = (req, res, next) => {
  console.log("");
  console.log("=".repeat(50));
  console.log("🔐 ADMIN AUTH CHECK");
  console.log("=".repeat(50));
  console.log(`📍 Route: ${req.method} ${req.path}`);

  const authHeader = req.headers.authorization;
  console.log(`🔑 Auth Header: ${authHeader ? "Present" : "MISSING"}`);

  // ─────────────────────────────────────────────────────────
  // Check if header exists and has correct format
  // ─────────────────────────────────────────────────────────
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log("❌ No valid authorization header");
    console.log("=".repeat(50));
    console.log("");
    return res.status(401).json({
      success: false,
      message: "No admin token provided",
      hint: "Please login first to get an admin token",
    });
  }

  const token = authHeader.split(" ")[1];

  // ─────────────────────────────────────────────────────────
  // Check for invalid token values (null, undefined, empty)
  // ─────────────────────────────────────────────────────────
  if (!token || token === "null" || token === "undefined" || token.trim() === "") {
    console.log(`❌ Token is null/undefined/empty: "${token}"`);
    console.log("=".repeat(50));
    console.log("");
    return res.status(401).json({
      success: false,
      message: "Invalid token - please login again",
      hint: "Token was null or undefined. Make sure you're logged in.",
    });
  }

  // Log partial token for debugging (first 20 chars)
  console.log(`🎫 Token: ${token.substring(0, 20)}...`);

  // ─────────────────────────────────────────────────────────
  // Verify JWT token
  // ─────────────────────────────────────────────────────────
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log(`✅ Token decoded successfully`);
    console.log(`   Role: ${decoded.role}`);
    console.log(`   Email: ${decoded.email || "N/A"}`);

    // Check if role is admin
    if (decoded.role !== "admin") {
      console.log(`❌ Not an admin role: ${decoded.role}`);
      console.log("=".repeat(50));
      console.log("");
      return res.status(403).json({
        success: false,
        message: "Admin access only",
        hint: "This endpoint requires admin privileges",
      });
    }

    console.log(`✅ Admin verified: ${decoded.email}`);
    console.log("=".repeat(50));
    console.log("");

    // Attach admin info to request
    req.admin = decoded;
    next();
  } catch (err) {
    console.log(`❌ Token verification failed: ${err.message}`);
    console.log("=".repeat(50));
    console.log("");

    // Handle specific JWT errors
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired - please login again",
        expired: true,
        hint: "Your session has expired. Please log in again.",
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token format",
        hint: "The token appears to be malformed. Please log in again.",
      });
    }

    if (err.name === "NotBeforeError") {
      return res.status(401).json({
        success: false,
        message: "Token not yet valid",
        hint: "This token is not yet active. Please try again later.",
      });
    }

    // Generic error
    return res.status(401).json({
      success: false,
      message: "Invalid or expired admin token",
      hint: "Please log in again to get a new token.",
    });
  }
};

/**
 * @desc    Optional: Check if request has valid admin token (non-blocking)
 * @usage   Use when you want to check admin status without blocking
 * @example router.get('/data', optionalAdminCheck, getData);
 */
export const optionalAdminCheck = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    req.isAdmin = false;
    return next();
  }

  const token = authHeader.split(" ")[1];

  if (!token || token === "null" || token === "undefined" || token.trim() === "") {
    req.isAdmin = false;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.isAdmin = decoded.role === "admin";
    req.admin = decoded.role === "admin" ? decoded : null;
  } catch (err) {
    req.isAdmin = false;
    req.admin = null;
  }

  next();
};