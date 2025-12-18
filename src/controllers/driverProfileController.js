import cloudinary from "../utils/cloudinary.js";
import User from "../models/User.js";
import streamifier from "streamifier";

/**
 * @desc    Upload driver's profile photo to Cloudinary and update user record
 * @route   POST /api/driver/uploadProfilePhoto
 * @access  Private (Driver)
 */
export const uploadDriverProfilePhoto = async (req, res) => {
  try {
    const phoneNumber = req.user.phone_number?.replace("+91", ""); // ✅ match DB format
    console.log("req.user from Firebase:", req.user);

    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No image file uploaded." });
    }

    // Upload image buffer to Cloudinary
    const streamUpload = (buffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "driver_profiles" },
          (error, result) => {
            if (result) resolve(result);
            else reject(error);
          }
        );
        streamifier.createReadStream(buffer).pipe(stream);
      });
    };

    const result = await streamUpload(file.buffer);

    // ✅ Match user by phone number
    const user = await User.findOneAndUpdate(
      { phone: phoneNumber },
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