// src/controllers/userController.js
import User from "../models/User.js";

/* Helper */
function formatMemberSince(createdAt) {
  const date = new Date(createdAt);
  const month = date.toLocaleString("default", { month: "long" });
  const year = date.getFullYear();
  return `${month} ${year}`;
}
/* GET USER BY ID */
export const getUserById = async (req, res) => {
  try {
    console.log("📥 GET /api/user/id/:id called");
    const { id } = req.params;
    
    // Try finding by MongoDB _id or firebaseUid
    let user = await User.findById(id);
    if (!user) {
      user = await User.findOne({ firebaseUid: id });
    }
    
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.status(200).json({
      message: "Profile fetched successfully.",
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (error) {
    console.error("Error in getUserById:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
// 🔔 SAVE FCM TOKEN (Driver / Customer)
export const saveFcmToken = async (req, res) => {
  try {
    const userId = req.user._id;
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ message: "FCM token is required" });
    }

    await User.findByIdAndUpdate(userId, { fcmToken });

    return res.status(200).json({
      message: "FCM token saved successfully",
    });
  } catch (error) {
    console.error("❌ saveFcmToken error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
/* CREATE or UPDATE USER */
export const createUser = async (req, res) => {
  try {
    const { phone, name, gender } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone number is required' });

    let user = await User.findOne({ phone });

    if (user) {
      // ✅ Update existing user
      user.name = name ?? user.name;
      user.gender = gender ?? user.gender;
      await user.save();
      return res.status(200).json({ message: 'User updated successfully' });
    } else {
      // ✅ Create new user
      user = new User({ phone, name, gender });
      await user.save();
      return res.status(201).json({ message: 'User created successfully' });
    }
  } catch (err) {
    console.error('Error in createUser:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/* UPDATE USER */
export const updateUser = async (req, res) => {
  try {
    console.log("🔧 PUT /api/user called");
    const { phone } = req.params;
    const {
      name,
      gender,
      email,
      dateOfBirth,
      emergencyContact,
      role,
      vehicleType,
      city,
      profilePhotoUrl,
      documentStatus,
    } = req.body;

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: "User not found." });

    // Only update fields if they are provided
    if (name !== undefined) user.name = name;
    if (gender !== undefined) user.gender = gender;
    if (email !== undefined) user.email = email;
    if (dateOfBirth !== undefined) user.dateOfBirth = dateOfBirth;
    if (emergencyContact !== undefined) user.emergencyContact = emergencyContact;
    if (role !== undefined) user.role = role;
    if (vehicleType !== undefined) user.vehicleType = vehicleType;
    if (city !== undefined) user.city = city;
    if (profilePhotoUrl !== undefined) user.profilePhotoUrl = profilePhotoUrl;
    if (documentStatus !== undefined) user.documentStatus = documentStatus;

    await user.save();

    return res.status(200).json({
      message: "Profile updated successfully.",
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (error) {
    console.error("Error in updateUser:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/* GET USER */
export const getUser = async (req, res) => {
  try {
    console.log("📥 GET /api/user called");
    const { phone } = req.params;
    const user = await User.findOne({ phone });

    if (!user) return res.status(404).json({ message: "User not found." });

    return res.status(200).json({
      message: "Profile fetched successfully.",
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (error) {
    console.error("Error in getUser:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/* DELETE USER */
export const deleteUser = async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await User.findOneAndDelete({ phone });

    if (!user) return res.status(404).json({ message: "User not found." });

    return res.status(200).json({ message: "Profile deleted successfully." });
  } catch (error) {
    console.error("Error in deleteUser:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};