export interface Agent {
  id: string;
  userId: string;
  code: string;
  name: string;
  description: string;
  modelType: string;
  modelConfig: any;
  handoffEnabled: boolean;
  systemInstructions: string;
  temperature: number;
  isActive: boolean;
  operatingHours: any;
  createdAt: number;
}
