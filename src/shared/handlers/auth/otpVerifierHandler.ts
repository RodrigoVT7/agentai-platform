// src/shared/handlers/auth/otpVerifierHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { JwtService } from "../../utils/jwt.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { TableServiceClient } from "@azure/data-tables";

export class OtpVerifierHandler {
  private storageService: StorageService;
  private jwtService: JwtService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.jwtService = new JwtService();
    this.logger = logger || createLogger();
  }
  
  async execute(data: any): Promise<any> {
    const { email, otp } = data;
    
    try {
      this.logger.info(`Verificando OTP para email: ${email}, OTP proporcionado: ${otp}`);
      
      // Enumerar todas las tablas para verificar
      await this.listTables();
      
      // Intenta buscar OTPs con diferentes variantes del email (para manejar case-sensitivity)
      const otpData = await this.findOtpWithEmailVariants(email, otp);
      
      if (!otpData || !otpData.userId) {
        throw createAppError(401, 'Código OTP inválido o expirado');
      }
      
      // Si llegamos aquí, tenemos un OTP válido
      this.logger.info(`OTP válido encontrado: ${otpData.rowKey}`);
      
      // Marcar OTP como usado
      this.logger.info(`Marcando OTP como usado`);
      const otpTableClient = this.storageService.getTableClient(STORAGE_TABLES.OTP_CODES);
      await otpTableClient.updateEntity({
        partitionKey: otpData.partitionKey,
        rowKey: otpData.rowKey,
        used: true
      }, "Merge");
      
      // Obtener información del usuario
      const userId = otpData.userId;
      this.logger.info(`Obteniendo información del usuario: ${userId}`);
      const userTableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      const user = await userTableClient.getEntity('user', userId);
      
      if (!user || !user.isActive) {
        throw createAppError(403, 'Usuario inactivo o no encontrado');
      }
      
      // Actualizar último login
      this.logger.info(`Actualizando último login para usuario: ${userId}`);
      await userTableClient.updateEntity({
        partitionKey: 'user',
        rowKey: userId,
        lastLogin: Date.now()
      }, "Merge");
      
      // Crear sesión
      const sessionId = uuidv4();
      this.logger.info(`Creando nueva sesión: ${sessionId}`);
      const sessionTableClient = this.storageService.getTableClient(STORAGE_TABLES.SESSIONS);
      
      const ipAddress = data.ip || null;
      
      await sessionTableClient.createEntity({
        partitionKey: userId,
        rowKey: sessionId,
        userId: userId,
        token: sessionId,
        ipAddress: ipAddress,
        expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 días
        isActive: true
      });
      
      // Generar token JWT
      this.logger.info(`Generando token JWT`);
      const token = this.jwtService.generateToken({
        userId: userId,
        email: email,
        sessionId
      });
      
      // Devolver respuesta
      return {
        userId: userId,
        email: email,
        firstName: user.firstName,
        token,
        expiresIn: 3600 // 1 hora en segundos
      };
    } catch (error: any) {
      this.logger.error('Error al verificar OTP:', error);
      
      if ('statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al verificar OTP');
    }
  }
  
  /**
   * Método para listar todas las tablas disponibles
   */
  private async listTables(): Promise<void> {
    try {
      // Obtener cliente de servicio de tabla directamente
      const connectionString = process.env.STORAGE_CONNECTION_STRING ?? "";
      const tableServiceClient = TableServiceClient.fromConnectionString(connectionString);
      
      // Listar tablas
      const tables = tableServiceClient.listTables();
      
      const tableNames: string[] = [];
      for await (const table of tables) {
        // Verificar que table.name esté definido antes de agregarlo
        if (table.name) {
          tableNames.push(table.name);
        }
      }
      
      this.logger.info(`Tablas disponibles: ${tableNames.join(', ')}`);
      this.logger.info(`Buscando en tabla: ${STORAGE_TABLES.OTP_CODES}`);
    } catch (error) {
      this.logger.error('Error al listar tablas:', error);
    }
  }
  
  /**
   * Prueba diferentes variantes del email para manejar case-sensitivity
   */
  private async findOtpWithEmailVariants(email: string, otpCode: string): Promise<any> {
    // Crear diferentes variantes del email para probar (Azure Table Storage es case-sensitive)
    const emailVariants = [
      email,
      email.toLowerCase(),
      email.toUpperCase(),
      // Primera letra mayúscula, resto minúsculas
      email.charAt(0).toUpperCase() + email.slice(1).toLowerCase()
    ];
    
    // Eliminar duplicados
    const uniqueVariants = [...new Set(emailVariants)];
    
    this.logger.info(`Probando con las siguientes variantes de email: ${uniqueVariants.join(', ')}`);
    
    // Probar cada variante
    for (const variant of uniqueVariants) {
      this.logger.info(`Buscando OTPs para email variant: "${variant}"`);
      
      const result = await this.tryDirectFetch(variant, otpCode);
      if (result) {
        this.logger.info(`OTP encontrado usando variante de email: ${variant}`);
        return result;
      }
    }
    
    // Último recurso: buscar todos los OTPs y comparar manualmente
    this.logger.info("Último recurso: buscando todos los OTPs...");
    
    try {
      // Buscar directamente en el código sin filtros
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.OTP_CODES);
      
      // Obtener todas las entidades (límite de 1000 para evitar problemas de rendimiento)
      const allEntities = await tableClient.listEntities();
      
      for await (const entity of allEntities) {
        this.logger.info(`Entidad en tabla: partitionKey=${entity.partitionKey}, rowKey=${entity.rowKey}, otp=${entity.otp}`);
        
        // Verificar si este OTP coincide
        if (entity.otp === otpCode && entity.used !== true) {
          // Verificar si la clave de partición se parece al email (ignorando case)
          const partitionKey = entity.partitionKey?.toString() || '';
          
          if (partitionKey.toLowerCase() === email.toLowerCase()) {
            this.logger.info(`OTP coincidente encontrado con búsqueda exhaustiva!`);
            return entity;
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error en búsqueda exhaustiva: ${error}`);
    }
    
    return null;
  }
  
  /**
   * Intenta recuperar el OTP directamente para un email específico
   */
  private async tryDirectFetch(email: string, otpCode: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.OTP_CODES);
      
      // Primero tratamos de encontrar todos los elementos con este email
      const allEntities = await tableClient.listEntities({
        queryOptions: { filter: `partitionKey eq '${email}'` }
      });
      
      // Buscar manualmente
      for await (const entity of allEntities) {
        this.logger.info(`Entidad encontrada - PartitionKey: ${entity.partitionKey}, RowKey: ${entity.rowKey}, OTP: ${entity.otp}, usado: ${entity.used}, expiresAt: ${entity.expiresAt}`);
        
        // Verificar si este OTP coincide
        if (entity.otp === otpCode) {
          this.logger.info(`OTP coincidente encontrado!`);
          
          // Verificar si ya se usó
          if (entity.used === true) {
            this.logger.info(`OTP ya fue usado anteriormente`);
            continue;
          }
          
          // Verificar expiración
          const now = Date.now();
          let expiresAt: number;
          
          if (typeof entity.expiresAt === 'number') {
            expiresAt = entity.expiresAt;
          } else if (typeof entity.expiresAt === 'string') {
            expiresAt = parseInt(entity.expiresAt, 10);
          } else if (entity.expiresAt instanceof Date) {
            expiresAt = entity.expiresAt.getTime();
          } else {
            this.logger.warn(`Tipo de expiresAt no reconocido: ${typeof entity.expiresAt}`);
            continue; // Siguiente entidad si no podemos interpretar la fecha
          }
          
          if (isNaN(expiresAt) || expiresAt <= now) {
            this.logger.info(`OTP expirado: ${expiresAt} <= ${now}`);
            continue;
          }
          
          // Si llegamos aquí, el OTP es válido
          return entity;
        }
      }
      
      this.logger.info(`No se encontró ningún OTP válido para ${email}`);
      return null;
    } catch (error) {
      this.logger.error('Error al buscar OTP directamente:', error);
      return null;
    }
  }
}