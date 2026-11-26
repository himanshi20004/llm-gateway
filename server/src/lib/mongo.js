import mongoose from 'mongoose';
import { config } from '../config/config.js';

// sanitizeFilter wraps any `$operator` smuggled in via user input in $eq (NoSQL injection defence).
mongoose.set('sanitizeFilter', true);
mongoose.set('strictQuery', true);

export const connectMongo = () =>
  mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 20 });
