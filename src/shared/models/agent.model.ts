export interface Agent {
  id: string;
  userId: string;
  code: string;
  name: string;
  description: string;
  modelType: string;
  modelConfig: string; // Cambiado de any a string
  handoffEnabled: boolean;
  systemInstructions: string;
  temperature: number;
  isActive: boolean;
  operatingHours: string | null; // Cambiado de any a string | null
  createdAt: number;
}