// src/shared/models/userRole.model.ts
export interface UserRole {
    id: string;
    agentId: string;
    userId: string;
    role: RoleType;
    invitedBy: string;
    email: string;
    status: InvitationStatus;
    createdAt: number;
    updatedAt?: number;
    isActive: boolean;
  }
  
  export enum RoleType {
    OWNER = 'owner',
    ADMIN = 'admin',
    EDITOR = 'editor',
    VIEWER = 'viewer',
    AGENT = 'agent'
  }
  
  export enum InvitationStatus {
    PENDING = 'pending',
    ACCEPTED = 'accepted',
    REJECTED = 'rejected',
    EXPIRED = 'expired'
  }