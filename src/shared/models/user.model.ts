// src/shared/models/user.model.ts
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName?: string;
  registrationIp?: string;
  googleId?: string;
  onboardingStatus: string;
  createdAt: number;
  lastLogin?: number;
  isActive: boolean;
}