import admin from "../utils/firebase.js";
import User from "../models/User.js";
import axios from "axios";

// Store OTPs temporarily (use Redis in production)
const otpStore = new Map();

// MSG91 Configuration
const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || 'YOUR_MSG91_AUTH_KEY';
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID || 'YOUR_TEMPLATE_ID';

/* ────────────── Send OTP ────────────── */
export const sendOTP = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const phoneKey = phone.replace(/^\+91/, "").replace(/^91/, "");
    const fullMobile = "91" + phoneKey;

    // Generate a 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP with a 5-minute expiration and attempt counter
    otpStore.set(phoneKey, {
      otp: otp,
      expiresAt: Date.now() + 5 * 60 * 1000,
      attempts: 0,
    });

    console.log(`📱 OTP for ${fullMobile}: ${otp}`);

    // Send OTP via MSG91 API
    const response = await axios.post(
      "https://control.msg91.com/api/v5/flow/",
      {
        template_id: process.env.MSG91_TEMPLATE_ID,
        sender: process.env.MSG91_SENDER_ID,
        recipients: [{ mobiles: fullMobile, var1: otp }],
      },
      {
        headers: {
          authkey: process.env.MSG91_AUTH_KEY,
          "content-type": "application/json",
        },
      }
    );

    console.log("✅ MSG91 Response:", response.data);

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (error) {
    console.error("❌ Error sending OTP:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
};
/* ────────────── Verify OTP and Login ────────────── */
/* ────────────── Verify OTP and Login ────────────── */
export const verifyOTPAndLogin = async (req, res) => {
  try {
    const { phone, otp, role } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ message: 'Phone and OTP are required' });
    }

    const phoneKey = phone.replace('+91', '');
    const storedData = otpStore.get(phoneKey);

    // --- OTP Validation ---
    if (!storedData) return res.status(400).json({ message: 'OTP not found. Please request a new one.' });
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(phoneKey);
      return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
    }
    if (storedData.attempts >= 3) {
      otpStore.delete(phoneKey);
      return res.status(400).json({ message: 'Too many failed attempts. Request a new OTP.' });
    }
    if (storedData.otp !== otp.toString()) {
      storedData.attempts += 1;
      return res.status(400).json({ message: 'Invalid OTP. Please try again.' });
    }

    otpStore.delete(phoneKey);
    console.log(`✅ OTP verified for ${phoneKey}`);

    // --- Find or Create User ---
    let user = await User.findOne({ phone: phoneKey });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = new User({
        phone: phoneKey,
        name: "New User",
        role: role || "customer",
        isDriver: role === "driver",
        vehicleType: role === "driver" ? null : undefined,
        
        // ✅ **FIX**: Add a default location object to satisfy the schema requirement.
        location: {
          type: 'Point',
          coordinates: [78.4867, 17.3850] // Default coordinates for Hyderabad
        }
      });
      await user.save();
      console.log(`✅ New user created with role '${role}': ${user._id}`);
    } else {
      // Handle existing customer converting to a driver
      if (role === "driver" && user.role !== "driver") {
        isNewUser = true; // Treat as a "new driver" for the app's onboarding flow
        user.role = "driver";
        user.isDriver = true;
        user.vehicleType = null; // Reset vehicle type for new driver registration
        await user.save();
        console.log(`🔄 Converted customer to driver: ${user._id}`);
      } else {
        console.log(`✅ Existing user logged in: ${user._id}`);
      }
    }

    // --- Firebase Token Generation ---
    let firebaseToken = null;
    try {
      if (!user.firebaseUid) {
        const firebaseUser = await admin.auth().createUser({ phoneNumber: phone, uid: user._id.toString() });
        user.firebaseUid = firebaseUser.uid;
        await user.save();
      }
      
      const claims = { phone: user.phone };
      firebaseToken = await admin.auth().createCustomToken(user.firebaseUid || user._id.toString(), claims);

    } catch (firebaseError) {
      console.error('⚠️ Firebase token creation failed:', firebaseError.message);
    }

    // --- Final Response Payload ---
    const profileComplete = user.name !== "New User";
    const docsApproved = user.documentStatus === 'approved';

    return res.status(200).json({
      message: isNewUser ? "Registration successful" : "Login successful",
      newUser: isNewUser,
      docsApproved: docsApproved,
      profileComplete: profileComplete,
      user: {
        _id: user._id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        isDriver: user.isDriver,
        vehicleType: user.vehicleType,
        documentStatus: user.documentStatus,
        memberSince: formatMemberSince(user.createdAt),
      },
      firebaseToken: firebaseToken,
    });

  } catch (error) {
    console.error('🔥 OTP verification error:', error);
    return res.status(500).json({ message: 'An error occurred during login.', error: error.message });
  }
};/* ────────────── Firebase Login (Original - Keep for compatibility) ────────────── */
export const firebaseLogin = async (req, res) => {
  try {
    const { idToken, phone, role } = req.body;
    
    if (!idToken || !phone) {
      return res.status(400).json({ message: "idToken and phone required" });
    }

    console.log(`🔐 Attempting to verify token...`);
    
    const decoded = await admin.auth().verifyIdToken(idToken);
    const { uid, phone_number } = decoded;

    const decodedPhone = (phone_number || '').replace(/^\+91/, '').slice(-10);
    const requestPhone = phone.replace(/^\+91/, '').slice(-10);

    console.log(`🔐 Token verified. Firebase: ${decodedPhone}, Request: ${requestPhone}`);

    if (decodedPhone !== requestPhone) {
      return res.status(401).json({ message: "Phone number mismatch" });
    }

    let user = await User.findOne({ phone: requestPhone });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = new User({
        firebaseUid: uid,
        phone: requestPhone,
        name: "New User",
        gender: "Not set",
        role: role || "customer",
        location: {
          type: "Point",
          coordinates: [78.4867, 17.3850]
        },
        isDriver: role === "driver" ? true : false,
        vehicleType: role === "driver" ? null : null,
        isDriverOnboarded: role === "driver" ? false : undefined,
      });
      
      await user.save();
      console.log(`✅ New user created with ID: ${user._id}`);
      
    } else {
      if (!user.firebaseUid) {
        user.firebaseUid = uid;
      }
      
      if (role === "driver" && user.role !== "driver") {
        isNewUser = true;
        user.role = "driver";
        user.isDriver = true;
        user.vehicleType = null;
        user.isDriverOnboarded = false;
      }
      
      await user.save();
      console.log(`🔄 Updated existing user: ${user._id}`);
    }

    const profileComplete = user.name !== "New User" && user.gender !== "Not set";

    return res.status(200).json({
      message: isNewUser ? "User created successfully" : "Login successful",
      newUser: isNewUser,
      profileComplete: profileComplete,
      user: {
        _id: user._id,
        id: user._id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        isDriver: user.isDriver || false,
        vehicleType: user.vehicleType,
        documentStatus: user.documentStatus,
        memberSince: formatMemberSince(user.createdAt),
      },
      userId: user._id.toString()
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

// Cleanup expired OTPs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(phone);
      console.log(`🗑️ Cleaned up expired OTP for ${phone}`);
    }
  }
}, 10 * 60 * 1000);