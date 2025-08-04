import mongoose from "mongoose";

const rideHistorySchema = new mongoose.Schema({
  phone: { type: String, required: true },
  pickupLocation: { type: String, required: true },
  dropLocation: { type: String, required: true },
  vehicleType: { type: String, required: true },
  fare: { type: Number, required: true },
  dateTime: { type: Date, default: Date.now }
});

const RideHistory = mongoose.model("RideHistory", rideHistorySchema);
export default RideHistory;
