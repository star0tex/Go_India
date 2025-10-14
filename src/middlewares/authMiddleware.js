// src/middlewares/authMiddleware.js
import admin from "../utils/firebase.js";
import User from "../models/User.js";

// Protect normal users
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ 
        success: false,
        message: "No token provided" 
      });
    }

    const token = authHeader.split(" ")[1];
    
    console.log("🔐 Verifying Firebase token...");
    
    const decodedToken = await admin.auth().verifyIdToken(token);

    // ✅ Check for the standard claim first, then fall back to our custom claim.
    const phoneInToken = decodedToken.phone_number || (decodedToken.phone ? `+91${decodedToken.phone}` : null);

    if (!phoneInToken) {
      return res.status(401).json({ 
        success: false,
        message: "Phone number not found in token" 
      });
    }

    console.log("🔐 Token verified for:", phoneInToken);

    // Find the MongoDB user using the normalized phone number
    const phone = phoneInToken.replace("+91", "").slice(-10);
    const user = await User.findOne({ phone });

    if (!user) {
      console.log(`❌ User not found in DB for phone: ${phone}`);
      return res.status(401).json({ 
        success: false,
        message: "User not found in DB" 
      });
    }

    console.log(`✅ User authenticated:`);
    console.log(`   MongoDB ID: ${user._id}`);
    console.log(`   Phone: ${user.phone}`);
    console.log(`   Role: ${user.role}`);
    console.log(`   Vehicle Type: ${user.vehicleType || 'not set'}`);

    // Attach both Firebase and MongoDB user info to the request
    req.user = {
      ...decodedToken,
      id: user._id,        // Attach MongoDB _id, not Firebase UID
      mongoId: user._id,   // Also keep as mongoId for clarity
      role: user.role,
      phone: user.phone,
      isDriver: user.isDriver,
      vehicleType: user.vehicleType
    };

    next(); // Proceed to the next function
  } catch (error) {
    console.error("❌ Auth middleware error:", error);
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired",
      error: error.message,
    });
  }
};

// Verify Firebase Token (alternative middleware)
export const verifyFirebaseToken = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ 
      success: false,
      message: "Missing Authorization header" 
    });
  }

  const token = header.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // 🔑 attach decoded Firebase user
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid Firebase token",
      error: err.message,
    });
  }
};

// Restrict access to only admin users
export const adminOnly = (req, res, next) => {
  try {
    // Example: Check a custom claim or hardcoded admin phone numbers
    const adminPhoneNumbers = ["+919999999999", "+918888888888"]; // sample admins
    
    const userPhone = req.user.phone_number || req.user.phone;
    
    if (!adminPhoneNumbers.includes(userPhone)) {
      return res.status(403).json({ 
        success: false,
        message: "Admin access only" 
      });
    }

    next();
  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: "Error checking admin rights", 
      error: err.message 
    });
  }
};