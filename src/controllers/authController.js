import admin from "../utils/firebase.js";
import User from "../models/User.js";



/* ────────────── Firebase Login ────────────── */
export const firebaseLogin = async (req, res) => {
  const { phone, role } = req.body;

  if (!phone) {
    return res.status(400).json({ message: "Phone is required." });
  }

  try {
    const decoded = req.user; // ✅ token already verified in middleware
    const decodedPhone = decoded.phone_number?.replace('+91', '').slice(-10);
    const requestPhone = phone.replace('+91', '').slice(-10);

    console.log("🔐 Token verified for:", decoded.phone_number);

    if (decodedPhone !== requestPhone) {
      return res.status(401).json({ message: "Token and phone mismatch." });
    }

    let user = await User.findOne({ phone: requestPhone });
    let newUser = false;

    if (!user) {
      // ✅ New user registration
      newUser = true;
      user = new User({
        phone: requestPhone,
        name: requestPhone,
        gender: "Not set",
        role: role || "customer",
        vehicleType: role === "driver" ? null : null,
        isDriverOnboarded: role === "driver" ? false : undefined,
      });
      await user.save();
    } else {
      // ✅ Existing user - if converting to driver
      if (role === "driver" && user.role !== "driver") {
        newUser = true; // treat as new driver onboarding
        user.role = "driver";
        user.vehicleType = null;
        user.isDriverOnboarded = false;
        await user.save();
      }
    }

    return res.status(200).json({
      message: "Login successful via Firebase.",
      newUser,
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (err) {
    return res.status(401).json({
      message: "Invalid Firebase token",
      error: err.message,
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
