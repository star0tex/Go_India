import admin from "../utils/firebase.js";
import User from "../models/User.js";

/* ────────────── Firebase Login ────────────── */
export const firebaseLogin = async (req, res) => {
  try {
    const { idToken, phone, role } = req.body;
    
    if (!idToken || !phone) {
      return res.status(400).json({ message: "idToken and phone required" });
    }

    console.log(`🔐 Attempting to verify token...`);
    
    // Verify the token directly
    const decoded = await admin.auth().verifyIdToken(idToken);
    const { uid, phone_number } = decoded;

    // Clean phone numbers for comparison
    const decodedPhone = (phone_number || '').replace(/^\+91/, '').slice(-10);
    const requestPhone = phone.replace(/^\+91/, '').slice(-10);

    console.log(`🔐 Token verified. Firebase: ${decodedPhone}, Request: ${requestPhone}`);

    if (decodedPhone !== requestPhone) {
      return res.status(401).json({ message: "Phone number mismatch" });
    }

    let user = await User.findOne({ phone: requestPhone });
    let isNewUser = false;

    if (!user) {
      // ✅ Create new user with REQUIRED location
      isNewUser = true;
      user = new User({
        firebaseUid: uid,                    // Save Firebase UID
        phone: requestPhone,
        name: "New User",                    // Default name
        gender: "Not set",                   // Default gender
        role: role || "customer",
        location: {
          type: "Point",
          coordinates: [78.4867, 17.3850]   // ✅ Required: Default Hyderabad coordinates [lng, lat]
        },
        // Set driver-specific fields if role is driver
        isDriver: role === "driver" ? true : false,
        vehicleType: role === "driver" ? null : null,
        isDriverOnboarded: role === "driver" ? false : undefined,
      });
      
      await user.save();
      console.log(`✅ New user created with ID: ${user._id}`);
      
    } else {
      // Update existing user
      if (!user.firebaseUid) {
        user.firebaseUid = uid;              // Add Firebase UID if missing
      }
      
      // Handle role conversion (customer → driver)
      if (role === "driver" && user.role !== "driver") {
        isNewUser = true; // Treat as new for driver onboarding flow
        user.role = "driver";
        user.isDriver = true;
        user.vehicleType = null;
        user.isDriverOnboarded = false;
      }
      
      await user.save();
      console.log(`🔄 Updated existing user: ${user._id}`);
    }

    // Return consistent response
    return res.status(200).json({
      message: isNewUser ? "User created successfully" : "Login successful",
      newUser: isNewUser,
      user: {
        _id: user._id,
        id: user._id,                        // For backward compatibility
        phone: user.phone,
        name: user.name,
        role: user.role,
        isDriver: user.isDriver || false,
        vehicleType: user.vehicleType,
        documentStatus: user.documentStatus,
        memberSince: formatMemberSince(user.createdAt),
      },
      userId: user._id.toString()            // For backward compatibility
    });

  } catch (error) {
    console.error('🔥 Login error:', error);
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({ 
        message: 'User validation failed', 
        error: error.message,
        details: error.errors
      });
    }
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ message: 'Token expired. Please login again.' });
    }
    
    if (error.code === 'auth/invalid-id-token') {
      return res.status(401).json({ message: 'Invalid token. Please login again.' });
    }
    
    return res.status(500).json({ 
      message: 'An error occurred during login.',
      error: error.message 
    });
  }
};

/* ────────────── Helper ────────────── */
function formatMemberSince(createdAt) {
  const date = new Date(createdAt);
  const month = date.toLocaleString("default", { month: "long" });
  const year = date.getFullYear();
  return `${month} ${year}`;
}