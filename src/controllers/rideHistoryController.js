import RideHistory from "../models/rideHistory.js";

export const saveRideHistory = async (req, res) => {
  try {
    const { pickupLocation, dropLocation, vehicleType, fare } = req.body;
    const phone = req.user.phone_number; // ✅ from verified token

    const newRide = new RideHistory({
      phone,
      pickupLocation,
      dropLocation,
      vehicleType,
      fare,
    });

    await newRide.save();
    res.status(201).json({ message: "Ride history saved successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error saving ride history", error });
  }
};

export const getRecentRides = async (req, res) => {
  try {
    const phone = req.user.phone_number; // ✅ from token

    const recentRides = await RideHistory.find({ phone })
      .sort({ dateTime: -1 })
      .limit(2);

    res.json(recentRides);
  } catch (error) {
    res.status(500).json({ message: "Error fetching history", error });
  }
};
