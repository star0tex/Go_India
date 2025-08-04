// src/controllers/adminController.js

import Trip from "../models/Trip.js";
import User from "../models/User.js";
import DriverDoc from "../models/DriverDoc.js";
import { sendToDriver, sendToCustomer } from "../utils/fcmSender.js";

/**
 * @desc    Manually assign a driver to a trip
 * @route   POST /api/admin/manual-assign
 */
export const manualAssignDriver = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const driver = await User.findById(driverId);
    if (!driver || !driver.isDriver) {
      return res.status(404).json({ message: "Driver not found or invalid" });
    }

    trip.assignedDriver = driverId;
    trip.status = "assigned";
    await trip.save();

    // Notify the driver
    if (driver.fcmToken) {
      await sendToDriver(driver.fcmToken, "New Trip Assigned", "You have a new trip assignment.");
    }

    return res.status(200).json({ message: "Driver assigned successfully", trip });
  } catch (err) {
    console.error("Manual assign error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Send push notification to filtered users (drivers/customers)
 * @route   POST /api/admin/push
 */
export const sendPushToUsers = async (req, res) => {
  try {
    const { title, body, role } = req.body;

    const users = await User.find(role ? { isDriver: role === "driver" } : {});
    let count = 0;

    for (const user of users) {
      if (user.fcmToken) {
        role === "driver"
          ? await sendToDriver(user.fcmToken, title, body)
          : await sendToCustomer(user.fcmToken, title, body);
        count++;
      }
    }

    res.status(200).json({ message: `Push sent to ${count} users.` });
  } catch (err) {
    console.error("Push error:", err);
    res.status(500).json({ message: "Failed to send push." });
  }
};

/**
 * @desc    Get full trip details including customer and driver info
 * @route   GET /api/admin/trip/:tripId
 */
export const getTripDetails = async (req, res) => {
  try {
    const { tripId } = req.params;

    const trip = await Trip.findById(tripId).lean();
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const customer = await User.findById(trip.customerId).lean();
    const driver = trip.assignedDriver ? await User.findById(trip.assignedDriver).lean() : null;

    res.status(200).json({
      trip,
      customer: customer
        ? {
            name: customer.name,
            phone: customer.phone,
            address: customer.address || "N/A",
          }
        : null,
      driver: driver
        ? {
            name: driver.name,
            phone: driver.phone,
            license: driver.license || "N/A",
          }
        : null,
    });
  } catch (err) {
    console.error("Trip detail fetch error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Get all uploaded documents by a specific driver
 * @route   GET /api/admin/documents/:driverId
 */
export const getDriverDocuments = async (req, res) => {
  try {
    const { driverId } = req.params;

    const documents = await DriverDoc.find({ userId: driverId });

    if (!documents || documents.length === 0) {
      return res.status(404).json({ message: "No documents found for this driver." });
    }

    res.status(200).json({
      message: "Documents retrieved successfully.",
      documents,
    });
  } catch (error) {
    console.error("Error fetching driver documents:", error);
    res.status(500).json({ message: "Server error while fetching documents." });
  }
};

/**
 * @desc    Verify or reject a specific document
 * @route   PUT /api/admin/verifyDocument/:docId
 */
export const verifyDriverDocument = async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, remarks } = req.body;

    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({
        message: "Invalid status. Must be 'verified' or 'rejected'.",
      });
    }

    const updatedDoc = await DriverDoc.findByIdAndUpdate(
      docId,
      { status, remarks },
      { new: true }
    );

    if (!updatedDoc) {
      return res.status(404).json({ message: "Document not found." });
    }

    res.status(200).json({
      message: `Document ${status} successfully.`,
      document: updatedDoc,
    });
  } catch (error) {
    console.error("Error updating document status:", error);
    res.status(500).json({ message: "Server error while verifying document." });
  }
};
