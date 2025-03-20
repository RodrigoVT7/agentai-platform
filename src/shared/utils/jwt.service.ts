// src/shared/utils/jwt.service.ts
import jwt, { SignOptions, Secret } from "jsonwebtoken";

export class JwtService {
  private secret: Secret;
  
  constructor() {
    this.secret = process.env.JWT_SECRET || "";
    if (!this.secret) {
      console.warn("ADVERTENCIA: JWT_SECRET no está configurado en las variables de entorno");
    }
  }
  
  generateToken(payload: Record<string, any>, expiresIn: string = "1h"): string {
    const options: SignOptions = { expiresIn };
    return jwt.sign(payload, this.secret, options);
  }
  
  verifyToken(token: string): any {
    return jwt.verify(token, this.secret);
  }
  
  decodeToken(token: string): any {
    return jwt.decode(token);
  }
}