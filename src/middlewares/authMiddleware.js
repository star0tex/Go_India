// src/middlewares/authMiddleware.js
import admin from "../utils/firebase.js";

// Protect normal users
// src/middlewares/authMiddleware.js
import User from "../models/User.js";

export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    if (!decodedToken.phone_number) {
      return res.status(401).json({ message: "Phone number not found in token" });
    }

    console.log("🔐 Token verified for:", decodedToken.phone_number);

    // ✅ find MongoDB user
    const phone = decodedToken.phone_number.replace("+91", "").slice(-10);
    const user = await User.findOne({ phone });

    if (!user) {
      return res.status(401).json({ message: "User not found in DB" });
    }

    req.user = {
      ...decodedToken,
      id: user._id,   // ✅ attach MongoDB _id, not Firebase UID
      role: user.role,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      message: "Token invalid or expired",
      error: error.message,
    });
  }
};
export const verifyFirebaseToken = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing Authorization header" });
  }

  const token = header.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // 🔑 attach decoded Firebase user
    next();
  } catch (err) {
    return res.status(401).json({
      message: "Invalid Firebase token",
      error: err.message,
    });
  }
};
// Restrict access to only admin users
export const adminOnly = (req, res, next) => {
  try {
    // 👇 Example: Check a custom claim or hardcoded admin UID
    const adminPhoneNumbers = ["+919999999999", "+918888888888"]; // sample admins
    if (!adminPhoneNumbers.includes(req.user.phone_number)) {
      return res.status(403).json({ message: "Admin access only" });
    }

    next();
  } catch (err) {
    res.status(500).json({ message: "Error checking admin rights", error: err.message });
  }
};
