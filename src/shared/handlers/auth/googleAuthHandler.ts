// src/shared/handlers/auth/googleAuthHandler.ts
import { v4 as uuidv4 } from "uuid";
import { OAuth2Client } from "google-auth-library";
import { StorageService } from "../../services/storage.service";
import { JwtService } from "../../utils/jwt.service";
import { User } from "../../models/user.model";
import { STORAGE_TABLES } from "../../constants";

// Crear cliente OAuth2 para verificar tokens de Google
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export class GoogleAuthHandler {
  private storageService: StorageService;
  private jwtService: JwtService;
  
  constructor() {
    this.storageService = new StorageService();
    this.jwtService = new JwtService();
  }
  
  async execute(data: any): Promise<any> {
    const { googleToken, ip } = data;
    
    try {
      // Verificar token de Google
      const ticket = await client.verifyIdToken({
        idToken: googleToken,
        audience: process.env.GOOGLE_CLIENT_ID
      });
      
      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        throw { statusCode: 400, message: 'Token de Google inválido' };
      }
      
      const { email, given_name, family_name, sub: googleId } = payload;
      
      // Buscar usuario por googleId o email
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      let user = null;
      
      // Buscar primero por googleId
      const usersByGoogleId = await tableClient.listEntities({
        queryOptions: { filter: `googleId eq '${googleId}'` }
      });
      
      for await (const entity of usersByGoogleId) {
        user = entity;
        break;
      }
      
      // Si no se encuentra por googleId, buscar por email
      if (!user) {
        const usersByEmail = await tableClient.listEntities({
          queryOptions: { filter: `email eq '${email}'` }
        });
        
        for await (const entity of usersByEmail) {
          user = entity;
          break;
        }
      }
      
      // Crear nuevo usuario si no existe
      if (!user) {
        const userId = uuidv4();
        
        const newUser: User = {
          id: userId,
          email: email,
          firstName: given_name || '',
          lastName: family_name || '',
          googleId: googleId,
          registrationIp: ip || null,
          onboardingStatus: 'pending',
          createdAt: Date.now(),
          isActive: true
        };
        
        await tableClient.createEntity({
          partitionKey: 'user',
          rowKey: userId,
          ...newUser
        });
        
        user = newUser;
      } else {
        // Actualizar usuario existente si es necesario
        const updateRequired = (
          user.googleId !== googleId || 
          user.firstName !== given_name || 
          user.lastName !== family_name
        );
        
        if (updateRequired) {
          await tableClient.updateEntity({
            partitionKey: 'user',
            rowKey: user.id,
            googleId: googleId,
            firstName: given_name || user.firstName,
            lastName: family_name || user.lastName,
            lastLogin: Date.now()
          }, "Merge");
        } else {
          // Solo actualizar último login
          await tableClient.updateEntity({
            partitionKey: 'user',
            rowKey: user.id,
            lastLogin: Date.now()
          }, "Merge");
        }
      }
      
      // Crear sesión
      const sessionId = uuidv4();
      const sessionTableClient = this.storageService.getTableClient(STORAGE_TABLES.SESSIONS);
      
      await sessionTableClient.createEntity({
        partitionKey: user.id,
        rowKey: sessionId,
        userId: user.id,
        token: sessionId,
        ipAddress: ip || null,
        expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 días
        isActive: true
      });
      
      // Generar token JWT
      const token = this.jwtService.generateToken({
        userId: user.id,
        email: email,
        sessionId
      });
      
      // Devolver respuesta
      return {
        userId: user.id,
        email: email,
        firstName: user.firstName,
        lastName: user.lastName,
        token,
        expiresIn: 3600, // 1 hora en segundos
        isNewUser: !user.lastLogin // Indicar si es un usuario nuevo
      };
    } catch (error) {
      console.error('Error en autenticación con Google:', error);
      if (error.statusCode) {
        throw error;
      }
      throw { statusCode: 500, message: 'Error en autenticación con Google' };
    }
  }
}