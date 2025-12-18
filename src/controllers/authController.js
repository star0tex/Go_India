// controllers/authController.js
import admin from "../utils/firebase.js";
import User from "../models/User.js";

// ✅ Import for recomputing driver document status
import { recomputeDriverDocumentStatus } from "./documentController.js";

/* ────────────── Firebase Sync (New Endpoint) ────────────── */
export const firebaseSync = async (req, res) => {
  try {
    const { phone, firebaseUid, role } = req.body;

    if (!phone || !firebaseUid) {
      return res.status(400).json({
        message: "Phone and firebaseUid are required",
      });
    }

    // Clean phone number (remove +91 or 91 prefix)
    const phoneKey = phone.replace(/^\+91/, "").replace(/^91/, "");

    console.log(`✅ Firebase sync for phone: ${phoneKey}, uid: ${firebaseUid}`);

    // ─────────────────────────────────────────────────────────
    // Find or Create User
    // ─────────────────────────────────────────────────────────
    let user = await User.findOne({ phone: phoneKey });
    let isNewUser = false;

    if (!user) {
      // ────────── New User Registration ──────────
      isNewUser = true;
      user = new User({
        phone: phoneKey,
        name: "New User",
        role: role || "customer",
        isDriver: role === "driver",
        firebaseUid: firebaseUid,
        // For drivers, we start with null vehicleType until onboarding
        vehicleType: role === "driver" ? null : undefined,
        location: {
          type: "Point",
          coordinates: [78.4867, 17.385], // Default coordinates (Hyderabad)
        },
      });
      await user.save();
      console.log(`✅ New user created with role '${role}': ${user._id}`);
    } else {
      // ────────── Existing User ──────────
      
      // Update Firebase UID if not set
      if (!user.firebaseUid) {
        user.firebaseUid = firebaseUid;
        await user.save();
        console.log(`🔄 Updated Firebase UID for existing user: ${user._id}`);
      }

      // Handle role conversion (customer → driver)
      if (role === "driver" && user.role !== "driver") {
        isNewUser = true;
        user.role = "driver";
        user.isDriver = true;
        user.vehicleType = null; // Force them through driver onboarding
        await user.save();
        console.log(`🔄 Converted customer to driver: ${user._id}`);
      } else {
        console.log(`✅ Existing user logged in: ${user._id}`);
      }
    }

    // ─────────────────────────────────────────────────────────
    // 🔁 Recompute Document Status for Drivers
    // ─────────────────────────────────────────────────────────
    if (user.isDriver && user.vehicleType) {
      try {
        console.log(
          `🔍 Recomputing document status for driver ${user._id} (vehicleType=${user.vehicleType})`
        );
        await recomputeDriverDocumentStatus(user._id.toString());

        // Refresh user from DB to get updated documentStatus / isVerified
        user = await User.findById(user._id);
        console.log(
          `🔁 After recompute in firebaseSync → user=${user._id} documentStatus=${user.documentStatus} isVerified=${user.isVerified}`
        );
      } catch (recomputeErr) {
        console.error(
          "⚠️ Failed to recompute driver documentStatus in firebaseSync:",
          recomputeErr.message
        );
      }
    } else {
      console.log(
        `ℹ️ Skipping recompute in firebaseSync: isDriver=${user.isDriver} vehicleType=${user.vehicleType}`
      );
    }

    // ─────────────────────────────────────────────────────────
    // Generate Firebase Custom Token (for compatibility)
    // ─────────────────────────────────────────────────────────
    let firebaseToken = null;
    try {
      const claims = { phone: user.phone };
      firebaseToken = await admin.auth().createCustomToken(firebaseUid, claims);
    } catch (firebaseError) {
      console.error("⚠️ Firebase token creation failed:", firebaseError.message);
    }

    // ─────────────────────────────────────────────────────────
    // Final Response Payload
    // ─────────────────────────────────────────────────────────
    const profileComplete = user.name !== "New User";
    const docsApproved = user.documentStatus === "approved";

    return res.status(200).json({
      message: isNewUser ? "Registration successful" : "Login successful",
      newUser: isNewUser,
      docsApproved: docsApproved,
      profileComplete: profileComplete,
      customerId: user._id,
      userId: user._id,
      user: {
        _id: user._id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        isDriver: user.isDriver,
        vehicleType: user.vehicleType,
        documentStatus: user.documentStatus,
        isVerified: user.isVerified,
        memberSince: formatMemberSince(user.createdAt),
      },
      firebaseToken: firebaseToken,
    });
  } catch (error) {
    console.error("🔥 Firebase sync error:", error);
    return res.status(500).json({
      message: "An error occurred during sync.",
      error: error.message,
    });
  }
};

/* ────────────── Helper Functions ────────────── */

/**
 * Format createdAt date to "Month Year" format
 * @param {Date} createdAt - User creation date
 * @returns {string} Formatted string like "January 2024"
 */
function formatMemberSince(createdAt) {
  const date = new Date(createdAt);
  const month = date.toLocaleString("default", { month: "long" });
  const year = date.getFullYear();
  return `${month} ${year}`;
}