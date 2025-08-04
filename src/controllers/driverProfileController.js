import cloudinary from "../utils/cloudinary.js";
import User from "../models/User.js";



/**
 * @desc    Upload driver's profile photo to Cloudinary and update user record
 * @route   POST /api/driver/uploadProfilePhoto
 * @access  Private (Driver)
 */
export const uploadDriverProfilePhoto = async (req, res) => {
  try {
    const userId = req.user.id; // assuming you're using auth middleware that sets req.user
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No image file uploaded." });
    }

    // Upload image to Cloudinary
    const result = await cloudinary.uploader.upload(file.path, {
      folder: "driver_profiles",
    });

    // Update user's profilePhotoUrl
    const user = await User.findByIdAndUpdate(
      userId,
      { profilePhotoUrl: result.secure_url },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.status(200).json({
      message: "Profile photo uploaded successfully.",
      profilePhotoUrl: result.secure_url,
    });
  } catch (error) {
    console.error("Error uploading driver profile photo:", error);
    res.status(500).json({ message: "Server error. Try again later." });
  }
};
