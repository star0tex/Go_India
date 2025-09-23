import User from "../models/User.js";

export const updateDriverVehicleType = async (req, res) => {
  try {
    const userId = req.user.id; // populated by protect middleware
    const { vehicleType } = req.body;

    if (!["bike", "auto", "car"].includes(vehicleType)) {
      return res.status(400).json({ message: "Invalid vehicle type" });
    }

    const driver = await User.findByIdAndUpdate(
      userId,
      { vehicleType: vehicleType.toLowerCase() },
      { new: true }
    );

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    res.status(200).json({
      message: `Vehicle type set to ${vehicleType}`,
      driver,
    });
  } catch (err) {
    console.error("❌ updateDriverVehicleType error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};