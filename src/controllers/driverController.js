import User from "../models/User.js";

export const updateDriverVehicleType = async (req, res) => {
  try {
    const userId = req.user.id; // populated by protect middleware
    const { vehicleType } = req.body;

    console.log(`🚗 Vehicle type update request for user: ${userId}`);
    console.log(`   Requested vehicle type: ${vehicleType}`);

    if (!vehicleType) {
      return res.status(400).json({ 
        success: false,
        message: "Vehicle type is required" 
      });
    }

    const normalizedType = vehicleType.toLowerCase().trim();

    if (!["bike", "auto", "car"].includes(normalizedType)) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid vehicle type. Must be: bike, auto, or car" 
      });
    }

    const driver = await User.findByIdAndUpdate(
      userId,
      { vehicleType: normalizedType },
      { new: true }
    );

    if (!driver) {
      return res.status(404).json({ 
        success: false,
        message: "Driver not found" 
      });
    }

    console.log(`✅ Vehicle type updated successfully:`);
    console.log(`   Driver ID: ${driver._id}`);
    console.log(`   Vehicle Type: ${driver.vehicleType}`);
    console.log(`   Phone: ${driver.phone}`);

    res.status(200).json({
      success: true,
      message: `Vehicle type set to ${normalizedType}`,
      vehicleType: driver.vehicleType,
      driver: {
        _id: driver._id,
        phone: driver.phone,
        name: driver.name,
        vehicleType: driver.vehicleType,
        isDriver: driver.isDriver,
        documentStatus: driver.documentStatus
      }
    });
  } catch (err) {
    console.error("❌ updateDriverVehicleType error:", err);
    res.status(500).json({ 
      success: false,
      message: "Server error", 
      error: err.message 
    });
  }
};