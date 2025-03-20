import jwt from "jsonwebtoken";

export class JwtService {
  private secret: string;
  
  constructor() {
    this.secret = process.env.JWT_SECRET || "";
  }
  
  generateToken(payload: any, expiresIn: string = "1h"): string {
    return jwt.sign(payload, this.secret, { expiresIn });
  }
  
  verifyToken(token: string): any {
    return jwt.verify(token, this.secret);
  }
  
  decodeToken(token: string): any {
    return jwt.decode(token);
  }
}
