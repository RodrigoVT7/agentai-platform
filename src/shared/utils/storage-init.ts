// src/shared/utils/storage-init.ts
import { TableServiceClient } from "@azure/data-tables";
import { STORAGE_TABLES } from "../constants";
import { Logger, createLogger } from "./logger";

export async function initializeStorage(logger?: Logger): Promise<void> {
  const log = logger || createLogger();
  log.info("Inicializando tablas de almacenamiento...");

  try {
    const connectionString = process.env.STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error(
        "No se ha configurado STORAGE_CONNECTION_STRING en las variables de entorno"
      );
    }

    const tableServiceClient =
      TableServiceClient.fromConnectionString(connectionString);

    // Lista de todas las tablas a crear
    const tables = Object.values(STORAGE_TABLES);

    // Crear cada tabla si no existe
    for (const tableName of tables) {
      log.info(`Verificando tabla: ${tableName}`);

      try {
        // Crear tabla directamente desde el servicio
        await tableServiceClient.createTable(tableName);
        log.info(`Tabla ${tableName} creada correctamente`);
      } catch (error: any) {
        // Ignorar el error si la tabla ya existe
        if (error.statusCode === 409) {
          log.info(`La tabla ${tableName} ya existe`);
        } else {
          log.error(`Error al crear tabla ${tableName}:`, error);
          throw error;
        }
      }
    }

    log.info("Todas las tablas han sido inicializadas correctamente");
  } catch (error: any) {
    log.error("Error al inicializar tablas de almacenamiento:", error);
    throw error;
  }
}
