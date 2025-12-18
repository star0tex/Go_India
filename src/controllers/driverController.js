// controllers/driverController.js
import User from "../models/User.js";

console.log("🚗 driverController loaded");

// ======================================================================
// 🚗 Update Driver Vehicle Type
// ======================================================================

/**
 * @desc    Update driver's vehicle type
 * @route   PUT /api/driver/vehicle-type
 * @access  Private (Driver)
 */
export const updateDriverVehicleType = async (req, res) => {
  try {
    const userId = req.user.id;
    const { vehicleType } = req.body;

    console.log("");
    console.log("=".repeat(70));
    console.log("🚗 UPDATE VEHICLE TYPE REQUEST");
    console.log("=".repeat(70));
    console.log(`   User ID: ${userId}`);
    console.log(`   Requested vehicle type: ${vehicleType}`);
    console.log("=".repeat(70));

    if (!vehicleType) {
      console.log("   ❌ Vehicle type is required");
      return res.status(400).json({
        success: false,
        message: "Vehicle type is required",
      });
    }

    const normalizedType = vehicleType.toLowerCase().trim();

    if (!["bike", "auto", "car"].includes(normalizedType)) {
      console.log(`   ❌ Invalid vehicle type: ${vehicleType}`);
      return res.status(400).json({
        success: false,
        message: "Invalid vehicle type. Must be: bike, auto, or car",
      });
    }

    const driver = await User.findByIdAndUpdate(
      userId,
      { vehicleType: normalizedType },
      { new: true }
    );

    if (!driver) {
      console.log("   ❌ Driver not found");
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    console.log("✅ Vehicle type updated successfully:");
    console.log(`   Driver ID: ${driver._id}`);
    console.log(`   Vehicle Type: ${driver.vehicleType}`);
    console.log(`   Phone: ${driver.phone}`);
    console.log("=".repeat(70));
    console.log("");

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
        documentStatus: driver.documentStatus,
      },
    });
  } catch (err) {
    console.error("❌ updateDriverVehicleType error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// ======================================================================
// 📝 Update Driver Profile
// ======================================================================

/**
 * @desc    Update driver profile (name, vehicle number, vehicle type, vehicle brand)
 * @route   PUT /api/driver/profile
 * @access  Private (Driver)
 */
export const updateDriverProfile = async (req, res) => {
  try {
    const userId = req.user.id; // From protect middleware
    const { phoneNumber, name, vehicleNumber, vehicleType, vehicleBrand } = req.body;

    console.log("");
    console.log("=".repeat(70));
    console.log("📝 UPDATE DRIVER PROFILE REQUEST");
    console.log("=".repeat(70));
    console.log(`   User ID: ${userId}`);
    console.log(`   Name: ${name}`);
    console.log(`   Vehicle Number: ${vehicleNumber}`);
    console.log(`   Vehicle Type: ${vehicleType}`);
    console.log(`   Vehicle Brand: ${vehicleBrand || "N/A"}`);
    console.log("=".repeat(70));

    // ✅ Validate required fields
    if (!name || !vehicleNumber) {
      console.log("   ❌ Validation failed: Missing required fields");
      return res.status(400).json({
        success: false,
        message: "Name and vehicle number are required",
      });
    }

    // ✅ Validate name
    const trimmedName = name.trim();
    if (trimmedName.length < 3) {
      console.log("   ❌ Validation failed: Name too short");
      return res.status(400).json({
        success: false,
        message: "Name must be at least 3 characters long",
      });
    }

    // ✅ Validate and format vehicle number
    const trimmedVehicleNumber = vehicleNumber.trim().toUpperCase();
    const vehicleNumberRegex = /^[A-Z]{2}\d{2}[A-Z]{0,2}\d{4}$/;

    if (!vehicleNumberRegex.test(trimmedVehicleNumber)) {
      console.log("   ❌ Validation failed: Invalid vehicle number format");
      return res.status(400).json({
        success: false,
        message: "Invalid vehicle number format (e.g., KA01AB1234)",
      });
    }

    // ✅ Check if vehicle number is already taken by another driver
    const existingDriver = await User.findOne({
      vehicleNumber: trimmedVehicleNumber,
      isDriver: true,
      _id: { $ne: userId }, // Exclude current user
    });

    if (existingDriver) {
      console.log(
        `   ⚠️ Vehicle number ${trimmedVehicleNumber} already registered to another driver`
      );
      return res.status(409).json({
        success: false,
        message: "This vehicle number is already registered",
      });
    }

    // ✅ Prepare update data
    const updateData = {
      name: trimmedName,
      vehicleNumber: trimmedVehicleNumber,
      updatedAt: new Date(),
    };

    // ✅ Add optional fields if provided
    if (vehicleType) {
      const normalizedType = vehicleType.toLowerCase().trim();
      if (["bike", "auto", "car"].includes(normalizedType)) {
        updateData.vehicleType = normalizedType;
      } else {
        console.log(`   ⚠️ Invalid vehicle type: ${vehicleType}`);
        return res.status(400).json({
          success: false,
          message: "Invalid vehicle type. Must be: bike, auto, or car",
        });
      }
    }

    if (vehicleBrand) {
      updateData.vehicleBrand = vehicleBrand.trim();
    }

    // ✅ Update driver in database
    const updatedDriver = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      {
        new: true, // Return updated document
        runValidators: true, // Run schema validators
      }
    ).select(
      "_id name phone vehicleNumber vehicleType vehicleBrand isDriver documentStatus"
    );

    if (!updatedDriver) {
      console.log("   ❌ Driver not found in database");
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    console.log("");
    console.log("✅ PROFILE UPDATED SUCCESSFULLY");
    console.log(`   Driver ID: ${updatedDriver._id}`);
    console.log(`   Name: ${updatedDriver.name}`);
    console.log(`   Vehicle Number: ${updatedDriver.vehicleNumber}`);
    console.log(`   Vehicle Type: ${updatedDriver.vehicleType}`);
    console.log(`   Vehicle Brand: ${updatedDriver.vehicleBrand || "N/A"}`);
    console.log("=".repeat(70));
    console.log("");

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      driver: {
        _id: updatedDriver._id,
        name: updatedDriver.name,
        phone: updatedDriver.phone,
        vehicleNumber: updatedDriver.vehicleNumber,
        vehicleType: updatedDriver.vehicleType,
        vehicleBrand: updatedDriver.vehicleBrand,
        isDriver: updatedDriver.isDriver,
        documentStatus: updatedDriver.documentStatus,
      },
    });
  } catch (error) {
    console.error("");
    console.error("=".repeat(70));
    console.error("❌ UPDATE DRIVER PROFILE ERROR");
    console.error(error);
    console.error("=".repeat(70));
    console.error("");

    res.status(500).json({
      success: false,
      message: "Server error while updating profile",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ======================================================================
// 🧹 Clear Driver State
// ======================================================================

/**
 * @desc    Clear driver state (reset isBusy, currentTripId, canReceiveNewRequests)
 * @route   POST /api/driver/clear-state
 * @access  Private (Driver)
 */
export const clearDriverState = async (req, res) => {
  try {
    // Prefer auth middleware ID; fall back to body if needed
    const userIdFromToken = req.user?.id;
    const { driverId: driverIdFromBody } = req.body || {};

    const driverId = userIdFromToken || driverIdFromBody;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    console.log("");
    console.log("=".repeat(70));
    console.log("🧹 CLEAR DRIVER STATE REQUEST");
    console.log("=".repeat(70));
    console.log(`   Driver ID: ${driverId}`);
    console.log("=".repeat(70));

    const driver = await User.findById(driverId);

    if (!driver || !driver.isDriver) {
      console.log("   ❌ Driver not found");
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    // Reset state fields
    driver.isBusy = false;
    driver.currentTripId = null;
    driver.canReceiveNewRequests = false;

    await driver.save();

    console.log("✅ Driver state cleared:");
    console.log(`   Driver: ${driver.name} (${driver._id})`);
    console.log(`   isBusy: ${driver.isBusy}`);
    console.log(`   currentTripId: ${driver.currentTripId}`);
    console.log(`   canReceiveNewRequests: ${driver.canReceiveNewRequests}`);
    console.log("=".repeat(70));
    console.log("");

    return res.status(200).json({
      success: true,
      message: "Driver state cleared successfully",
      driver: {
        _id: driver._id,
        phone: driver.phone,
        name: driver.name,
        isBusy: driver.isBusy,
        currentTripId: driver.currentTripId,
        canReceiveNewRequests: driver.canReceiveNewRequests,
      },
    });
  } catch (err) {
    console.error("❌ clearDriverState error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};