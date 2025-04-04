// src/shared/handlers/integrations/erpConnectorHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  Integration, 
  IntegrationType, 
  IntegrationStatus,
  IntegrationERPConfig 
} from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";

export class ERPConnectorHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async getSchemas(erpType: string): Promise<HttpResponseInit> {
    try {
      // Devolver esquemas predefinidos según el tipo de ERP
      let schemas: any[] = [];
      
      switch (erpType.toLowerCase()) {
        case 'sap':
          schemas = [
            {
              name: "sales",
              entities: [
                { name: "customer", fields: ["id", "name", "address", "email", "phone"] },
                { name: "salesOrder", fields: ["id", "customerId", "date", "totalAmount", "status"] },
                { name: "invoice", fields: ["id", "salesOrderId", "date", "amount", "status"] }
              ]
            },
            {
              name: "inventory",
              entities: [
                { name: "product", fields: ["id", "code", "name", "description", "price", "stock"] },
                { name: "warehouse", fields: ["id", "name", "location", "capacity"] },
                { name: "movement", fields: ["id", "productId", "warehouseId", "quantity", "type", "date"] }
              ]
            }
          ];
          break;
          
        case 'dynamics':
          schemas = [
            {
              name: "crm",
              entities: [
                { name: "contact", fields: ["id", "firstName", "lastName", "email", "phone", "company"] },
                { name: "opportunity", fields: ["id", "name", "contactId", "stage", "amount", "closeDate"] },
                { name: "account", fields: ["id", "name", "industry", "revenue", "employees"] }
              ]
            },
            {
              name: "finance",
              entities: [
                { name: "invoice", fields: ["id", "accountId", "date", "amount", "status"] },
                { name: "payment", fields: ["id", "invoiceId", "date", "amount", "method"] }
              ]
            }
          ];
          break;
          
        case 'odoo':
          schemas = [
            {
              name: "sales",
              entities: [
                { name: "partner", fields: ["id", "name", "email", "phone", "address"] },
                { name: "sale_order", fields: ["id", "partner_id", "date_order", "amount_total", "state"] }
              ]
            },
            {
              name: "inventory",
              entities: [
                { name: "product", fields: ["id", "name", "default_code", "list_price", "qty_available"] },
                { name: "stock_move", fields: ["id", "product_id", "location_id", "location_dest_id", "quantity"] }
              ]
            }
          ];
          break;
          
        default:
          schemas = [
            {
              name: "generic",
              entities: [
                { name: "customer", fields: ["id", "name", "email", "phone"] },
                { name: "product", fields: ["id", "name", "price", "stock"] },
                { name: "order", fields: ["id", "customerId", "date", "total"] }
              ]
            }
          ];
      }
      
      return {
        status: 200,
        jsonBody: {
          type: erpType,
          schemas
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener esquemas para ERP ${erpType}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener esquemas: ${errorMessage}` }
      };
    }
  }
  
  async getEntities(integrationId: string, schema: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      const config = integration.config as IntegrationERPConfig;
      
      // Filtrar esquemas disponibles
      let entities: any[] = [];
      
      if (config.schemas && Array.isArray(config.schemas)) {
        const selectedSchema = config.schemas.find(s => s.name === schema);
        if (selectedSchema && selectedSchema.entities) {
          entities = selectedSchema.entities;
        }
      }
      
      // Si no hay esquemas configurados, intentar obtener desde API del ERP
      if (entities.length === 0 && integration.status === IntegrationStatus.ACTIVE) {
        try {
          // Aquí iría la lógica para conectar con el ERP y obtener entidades
          // Este es un ejemplo y sería específico para cada ERP
          
          // Por ejemplo, para un ERP genérico con API REST:
          const baseUrl = config.url;
          const apiKey = config.apiKey;
          
          const response = await fetch(`${baseUrl}/api/schema/${schema}/entities`, {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            }
          });
          
          if (response.ok) {
            const result = await response.json();
            entities = result.entities || [];
          }
        } catch (apiError) {
          this.logger.warn(`Error al obtener entidades desde API del ERP:`, apiError);
          // Continuar con entidades en caché o esquema predefinido
        }
      }
      
      return {
        status: 200,
        jsonBody: {
          schema,
          entities,
          integrationId
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener entidades para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener entidades: ${errorMessage}` }
      };
    }
  }
  
  async queryData(
    integrationId: string, 
    entity: string, 
    userId: string, 
    options: { filter?: string, limit: number }
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP y está activa
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      if (integration.status !== IntegrationStatus.ACTIVE) {
        return {
          status: 400,
          jsonBody: { error: "La integración no está activa" }
        };
      }
      
      const config = integration.config as IntegrationERPConfig;
      
      // Construir consulta para el ERP
      // Aquí implementaríamos la lógica específica para cada tipo de ERP
      
      try {
        // Ejemplo para un ERP genérico con API REST
        const baseUrl = config.url;
        const apiKey = config.apiKey;
        
        let url = `${baseUrl}/api/data/${entity}?limit=${options.limit}`;
        if (options.filter) {
          url += `&filter=${encodeURIComponent(options.filter)}`;
        }
        
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          return {
            status: response.status,
            jsonBody: { 
              error: "Error al consultar datos en el ERP", 
              apiError: await response.text() 
            }
          };
        }
        
        const result = await response.json();
        
        return {
          status: 200,
          jsonBody: {
            entity,
            data: result.data || [],
            total: result.total || result.data?.length || 0,
            limit: options.limit
          }
        };
      } catch (apiError) {
        return {
          status: 500,
          jsonBody: { 
            error: "Error al conectar con el ERP", 
            details: apiError instanceof Error ? apiError.message : String(apiError)
          }
        };
      }
    } catch (error) {
      this.logger.error(`Error al consultar datos para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al consultar datos: ${errorMessage}` }
      };
    }
  }
  
  async testConnection(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      const config = integration.config as IntegrationERPConfig;
      
      // Probar conexión según tipo de ERP
      let isConnected = false;
      let details = {};
      
      try {
        // Ejemplo para un ERP genérico con API REST
        const baseUrl = config.url;
        
        // Intentar conexión con endpoint de prueba o de información
        let url = `${baseUrl}/api/ping`;
        let headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        
        // Añadir autenticación según configuración
        if (config.apiKey) {
          headers['Authorization'] = `Bearer ${config.apiKey}`;
        } else if (config.username && config.password) {
          headers['Authorization'] = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
        }
        
        const response = await fetch(url, { headers });
        
        if (response.ok) {
          isConnected = true;
          details = await response.json();
          
          // Actualizar estado de la integración
          await this.updateIntegrationStatus(integrationId, integration.agentId, IntegrationStatus.ACTIVE);
        } else {
          details = { 
            statusCode: response.status, 
            error: await response.text() 
          };
          
          // Actualizar estado de la integración a ERROR
          await this.updateIntegrationStatus(integrationId, integration.agentId, IntegrationStatus.ERROR);
        }
      } catch (apiError) {
        details = { 
          error: apiError instanceof Error ? apiError.message : String(apiError) 
        };
        
        // Actualizar estado de la integración a ERROR
        await this.updateIntegrationStatus(integrationId, integration.agentId, IntegrationStatus.ERROR);
      }
      
      return {
        status: 200,
        jsonBody: {
          integrationId,
          connected: isConnected,
          status: isConnected ? IntegrationStatus.ACTIVE : IntegrationStatus.ERROR,
          details,
          timestamp: Date.now()
        }
      };
    } catch (error) {
      this.logger.error(`Error al probar conexión para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al probar conexión: ${errorMessage}` }
      };
    }
  }
  
  async getIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta integración" }
        };
      }
      
      // No devolver credenciales sensibles
      const { credentials, ...safeIntegration } = integration;
      
      return {
        status: 200,
        jsonBody: safeIntegration
      };
    } catch (error) {
      this.logger.error(`Error al obtener integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener integración: ${errorMessage}` }
      };
    }
  }
  
  async createIntegration(data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const { 
        agentId, 
        name, 
        description, 
        type,
        url,
        username,
        password,
        apiKey,
        tenant,
        companyId,
        connectionParams,
        schemas
      } = data;
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar este agente" }
        };
      }
      
      // Generar ID para la integración
      const integrationId = uuidv4();
      const now = Date.now();
      
      // Preparar configuración del ERP
      const config: IntegrationERPConfig = {
        type: type || 'generic',
        url,
        username,
        password,
        apiKey,
        tenant,
        companyId,
        connectionParams,
        schemas
      };
      
      // Crear credenciales (en producción, encriptar)
      const credentials = apiKey || (username && password ? 
        JSON.stringify({ username, password }) : '');
      
      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name,
        description: description || `Integración con ${type || 'ERP genérico'}`,
        type: IntegrationType.ERP,
        provider: type || 'generic',
        config,
        credentials,
        status: IntegrationStatus.CONFIGURED,
        createdBy: userId,
        createdAt: now,
        isActive: true
      };
      
      // Guardar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: integrationId,
        ...integration
      });
      
      return {
        status: 201,
        jsonBody: {
          id: integrationId,
          name,
          status: IntegrationStatus.CONFIGURED,
          message: "Integración ERP creada con éxito"
        }
      };
    } catch (error) {
      this.logger.error("Error al crear integración ERP:", error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al crear integración: ${errorMessage}` }
      };
    }
  }
  
  async updateIntegration(integrationId: string, data: any, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      // Obtener configuración actual
      const config = integration.config as IntegrationERPConfig;
      
      // Actualizar campos de configuración
      const updatedConfig: IntegrationERPConfig = {
        ...config,
        url: data.url || config.url,
        username: data.username || config.username,
        password: data.password || config.password,
        apiKey: data.apiKey || config.apiKey,
        tenant: data.tenant || config.tenant,
        companyId: data.companyId || config.companyId,
        connectionParams: data.connectionParams || config.connectionParams,
        schemas: data.schemas || config.schemas
      };
      
      // Preparar datos para actualización
      const updateData: any = {
        partitionKey: integration.agentId,
        rowKey: integrationId,
        config: updatedConfig,
        updatedAt: Date.now()
      };
      
      // Actualizar nombre si se proporciona
      if (data.name) {
        updateData.name = data.name;
      }
      
      // Actualizar descripción si se proporciona
      if (data.description) {
        updateData.description = data.description;
      }
      
      // Actualizar credenciales si se proporcionan
      if (data.apiKey || (data.username && data.password)) {
        updateData.credentials = data.apiKey || JSON.stringify({ 
          username: data.username || config.username, 
          password: data.password || config.password 
        });
      }
      
      // Actualizar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity(updateData, "Merge");
      
      return {
        status: 200,
        jsonBody: {
          id: integrationId,
          name: data.name || integration.name,
          status: integration.status,
          message: "Integración ERP actualizada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar integración ERP ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al actualizar integración: ${errorMessage}` }
      };
    }
  }
  
  async deleteIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para eliminar esta integración" }
        };
      }
      
      // Realizar eliminación lógica
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity({
        partitionKey: integration.agentId,
        rowKey: integrationId,
        isActive: false,
        updatedAt: Date.now()
      }, "Merge");
      
      return {
        status: 200,
        jsonBody: {
          id: integrationId,
          message: "Integración ERP eliminada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar integración ERP ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al eliminar integración: ${errorMessage}` }
      };
    }
  }
  
  async createRecord(integrationId: string, entity: string, data: any, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP y está activa
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      if (integration.status !== IntegrationStatus.ACTIVE) {
        return {
          status: 400,
          jsonBody: { error: "La integración no está activa" }
        };
      }
      
      const config = integration.config as IntegrationERPConfig;
      
      // Crear registro en el ERP
      try {
        // Ejemplo para un ERP genérico con API REST
        const baseUrl = config.url;
        const apiKey = config.apiKey;
        
        const url = `${baseUrl}/api/data/${entity}`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(data)
        });
        
        if (!response.ok) {
          return {
            status: response.status,
            jsonBody: { 
              error: "Error al crear registro en el ERP", 
              apiError: await response.text() 
            }
          };
        }
        
        const result = await response.json();
        
        return {
          status: 201,
          jsonBody: {
            id: result.id,
            entity,
            data: result,
            message: "Registro creado con éxito"
          }
        };
      } catch (apiError) {
        return {
          status: 500,
          jsonBody: { 
            error: "Error al conectar con el ERP", 
            details: apiError instanceof Error ? apiError.message : String(apiError)
          }
        };
      }
    } catch (error) {
      this.logger.error(`Error al crear registro en integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al crear registro: ${errorMessage}` }
      };
    }
  }
  
  async updateRecord(
    integrationId: string, 
    entity: string, 
    recordId: string, 
    data: any, 
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP y está activa
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      if (integration.status !== IntegrationStatus.ACTIVE) {
        return {
          status: 400,
          jsonBody: { error: "La integración no está activa" }
        };
      }
      
      const config = integration.config as IntegrationERPConfig;
      
      // Actualizar registro en el ERP
      try {
        // Ejemplo para un ERP genérico con API REST
        const baseUrl = config.url;
        const apiKey = config.apiKey;
        
        const url = `${baseUrl}/api/data/${entity}/${recordId}`;
        
        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(data)
        });
        
        if (!response.ok) {
          return {
            status: response.status,
            jsonBody: { 
              error: "Error al actualizar registro en el ERP", 
              apiError: await response.text() 
            }
          };
        }
        
        const result = await response.json();
        
        return {
          status: 200,
          jsonBody: {
            id: recordId,
            entity,
            data: result,
            message: "Registro actualizado con éxito"
          }
        };
      } catch (apiError) {
        return {
          status: 500,
          jsonBody: { 
            error: "Error al conectar con el ERP", 
            details: apiError instanceof Error ? apiError.message : String(apiError)
          }
        };
      }
    } catch (error) {
      this.logger.error(`Error al actualizar registro en integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al actualizar registro: ${errorMessage}` }
      };
    }
  }
  
  async deleteRecord(
    integrationId: string, 
    entity: string, 
    recordId: string, 
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP y está activa
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      if (integration.status !== IntegrationStatus.ACTIVE) {
        return {
          status: 400,
          jsonBody: { error: "La integración no está activa" }
        };
      }
      
      const config = integration.config as IntegrationERPConfig;
      
      // Eliminar registro en el ERP
      try {
        // Ejemplo para un ERP genérico con API REST
        const baseUrl = config.url;
        const apiKey = config.apiKey;
        
        const url = `${baseUrl}/api/data/${entity}/${recordId}`;
        
        const response = await fetch(url, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          return {
            status: response.status,
            jsonBody: { 
              error: "Error al eliminar registro en el ERP", 
              apiError: await response.text() 
            }
          };
        }
        
        return {
          status: 200,
          jsonBody: {
            id: recordId,
            entity,
            message: "Registro eliminado con éxito"
          }
        };
      } catch (apiError) {
        return {
          status: 500,
          jsonBody: { 
            error: "Error al conectar con el ERP", 
            details: apiError instanceof Error ? apiError.message : String(apiError)
          }
        };
      }
    } catch (error) {
      this.logger.error(`Error al eliminar registro en integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al eliminar registro: ${errorMessage}` }
      };
    }
  }
  
  async executeQuery(integrationId: string, query: any, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo ERP y está activa
      if (integration.type !== IntegrationType.ERP) {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de tipo ERP" }
        };
      }
      
      if (integration.status !== IntegrationStatus.ACTIVE) {
        return {
          status: 400,
          jsonBody: { error: "La integración no está activa" }
        };
      }
      
      const config = integration.config as IntegrationERPConfig;
      
      // Ejecutar consulta personalizada en el ERP
      try {
        // Ejemplo para un ERP genérico con API REST
        const baseUrl = config.url;
        const apiKey = config.apiKey;
        
        const url = `${baseUrl}/api/query`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(query)
        });
        
        if (!response.ok) {
          return {
            status: response.status,
            jsonBody: { 
              error: "Error al ejecutar consulta en el ERP", 
              apiError: await response.text() 
            }
          };
        }
        
        const result = await response.json();
        
        return {
          status: 200,
          jsonBody: {
            query: query.sql || query.query,
            data: result.data || result,
            totalRows: result.totalRows || result.data?.length || 0,
            execution: {
              time: result.executionTime || 0,
              success: true
            }
          }
        };
      } catch (apiError) {
        return {
          status: 500,
          jsonBody: { 
            error: "Error al conectar con el ERP", 
            details: apiError instanceof Error ? apiError.message : String(apiError)
          }
        };
      }
    } catch (error) {
      this.logger.error(`Error al ejecutar consulta en integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al ejecutar consulta: ${errorMessage}` }
      };
    }
  }
  
  // Métodos auxiliares
  
  private async fetchIntegration(integrationId: string): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      // Buscar en todas las particiones
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      
      for await (const integration of integrations) {
        return integration as unknown as Integration;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al buscar integración ${integrationId}:`, error);
      return null;
    }
  }
  
  private async verifyAccess(agentId: string, userId: string): Promise<boolean> {
    try {
      // Verificar si el usuario es propietario del agente
      const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await agentsTable.getEntity('agent', agentId);
        
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        return false;
      }
      
      // Verificar si el usuario tiene algún rol en el agente
      const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = rolesTable.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
      });
      
      for await (const role of roles) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar acceso al agente ${agentId}:`, error);
      return false;
    }
  }
  
  private async updateIntegrationStatus(integrationId: string, agentId: string, status: IntegrationStatus): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      await tableClient.updateEntity({
        partitionKey: agentId,
        rowKey: integrationId,
        status,
        updatedAt: Date.now()
      }, "Merge");
    } catch (error) {
      this.logger.error(`Error al actualizar estado de integración ${integrationId}:`, error);
    }
  }
}