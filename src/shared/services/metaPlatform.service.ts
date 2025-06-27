// src/shared/services/metaPlatform.service.ts
import { Logger, createLogger } from "../utils/logger";
import { createAppError } from "../utils/error.utils";
import fetch from "node-fetch";
import {
  MetaAccessTokenResponse,
  WhatsAppBusinessAccountResponse,
  WhatsAppPhoneNumberAPI,
  MetaSubscribedAppsResponse,
} from "../models/meta.model";

export class MetaPlatformService {
  private logger: Logger;
  private appId: string;
  private appSecret: string;
  private embeddedSignupRedirectUri: string;

  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.appId = process.env.META_APP_ID || "";
    this.appSecret = process.env.META_APP_SECRET || "";
    this.embeddedSignupRedirectUri =
      process.env.META_WHATSAPP_EMBEDDED_SIGNUP_REDIRECT_URI || "";

    if (!this.appId || !this.appSecret || !this.embeddedSignupRedirectUri) {
      this.logger.error("Meta API credentials not fully configured.");
      // In a real application, you might throw an error or handle this more gracefully
      // depending on whether Meta features are critical for startup.
    }
  }

  /**
   * Exchanges an authorization code obtained from Meta's Embedded Signup for an Access Token.
   * @param code The authorization code.
   * @returns An object containing the access token.
   */
  public async exchangeCodeForToken(
    code: string
  ): Promise<MetaAccessTokenResponse | null> {
    const url = new URL("https://graph.facebook.com/v22.0/oauth/access_token");
    url.searchParams.append("client_id", this.appId);
    url.searchParams.append("client_secret", this.appSecret);
    url.searchParams.append("code", code); // The embedded signup code

    this.logger.info("Attempting to exchange Meta ES code for access token.");

    try {
      const response = await fetch(url.toString(), { method: "GET" });
      const responseData = await response.json() as MetaAccessTokenResponse;

      if (!response.ok) {
        this.logger.error(
          `Failed to exchange Meta ES code. Status: ${response.status}, Body: ${JSON.stringify(responseData)}`
        );
        throw createAppError(
          response.status,
          "Failed to exchange code for Meta access token",
          responseData
        );
      }
      this.logger.info("Successfully exchanged Meta ES code for access token.");
      return responseData;
    } catch (error) {
      this.logger.error("Error exchanging Meta ES code for token:", error);
      throw error;
    }
  }

  /**
   * Retrieves data for a specific WhatsApp Phone Number ID.
   * @param wabaId The WhatsApp Business Account ID.
   * @param accessToken The access token to authenticate the request.
   * @param phoneNumberId The specific Phone Number ID to retrieve.
   * @returns Phone number data or null if not found/error.
   */
  public async getPhoneNumberData(
    wabaId: string,
    accessToken: string,
    phoneNumberId: string
  ): Promise<WhatsAppPhoneNumberAPI | null> {
    const url = `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`;
    const fields = "id,display_phone_number,verified_name,quality_rating";

    this.logger.info(`Fetching phone number data for WABA: ${wabaId}, Phone ID: ${phoneNumberId}`);

    try {
      const response = await fetch(`${url}?fields=${fields}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const responseData = await response.json();

      if (!response.ok) {
        this.logger.error(
          `Error fetching phone numbers for WABA ${wabaId}. Status: ${response.status}, Body: ${JSON.stringify(responseData)}`
        );
        throw createAppError(
          response.status,
          `Failed to fetch phone number data for WABA ${wabaId}`,
          responseData
        );
      }

      const phoneData =
        responseData.data?.find((phone: any) => phone.id === phoneNumberId) ||
        null;

      if (!phoneData) {
        this.logger.warn(`Phone number ${phoneNumberId} not found in WABA ${wabaId} or response data.`);
      } else {
        this.logger.info(`Phone number data retrieved for ${phoneNumberId}: ${phoneData.display_phone_number}`);
      }
      return phoneData;
    } catch (error) {
      this.logger.error("Error fetching phone number data:", error);
      throw error;
    }
  }

  /**
   * Retrieves data for a specific WhatsApp Business Account (WABA).
   * @param wabaId The WhatsApp Business Account ID.
   * @param accessToken The access token to authenticate the request.
   * @returns WABA data or null if not found/error.
   */
  public async getWhatsAppBusinessAccountData(
    wabaId: string,
    accessToken: string
  ): Promise<WhatsAppBusinessAccountResponse | null> {
    const url = `https://graph.facebook.com/v22.0/${wabaId}`;
    const fields = "id,name,currency,owner_business_info";

    this.logger.info(`Fetching WABA data for ID: ${wabaId}`);

    try {
      const response = await fetch(`${url}?fields=${fields}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const responseData = await response.json() as WhatsAppBusinessAccountResponse;

      if (!response.ok) {
        this.logger.error(
          `Error fetching WABA data for ${wabaId}. Status: ${response.status}, Body: ${JSON.stringify(responseData)}`
        );
        throw createAppError(
          response.status,
          `Failed to fetch WABA data for ${wabaId}`,
          responseData
        );
      }
      this.logger.info(`WABA data retrieved for ${wabaId}: ${responseData.name}`);
      return responseData;
    } catch (error) {
      this.logger.error("Error fetching WABA data:", error);
      throw error;
    }
  }

  /**
   * Subscribes your application to a WhatsApp Business Account for webhook notifications.
   * @param wabaId The WhatsApp Business Account ID.
   * @param accessToken The access token to authenticate the request.
   * @returns True if subscription was successful, false otherwise.
   */
  public async subscribeAppToWABA(
    wabaId: string,
    accessToken: string
  ): Promise<boolean> {
    const url = `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`;

    this.logger.info(`Attempting to subscribe app to WABA: ${wabaId}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const responseData = await response.json() as MetaSubscribedAppsResponse;

      if (!response.ok) {
        this.logger.error(
          `Error subscribing app to WABA ${wabaId}. Status: ${response.status}, Body: ${JSON.stringify(responseData)}`
        );
        // Meta often returns a 400 if already subscribed, which is fine for our purpose
        if (response.status === 400 && (responseData as any)?.error?.code === 130517) {
            this.logger.warn(`App is already subscribed to WABA ${wabaId} (code 130517).`);
            return true; // Consider it a success if already subscribed
        }
        throw createAppError(
          response.status,
          `Failed to subscribe app to WABA ${wabaId}`,
          responseData
        );
      }
      this.logger.info(`Successfully subscribed app to WABA ${wabaId}.`);
      return response.ok;
    } catch (error) {
      this.logger.error("Error subscribing app to WABA:", error);
      throw error;
    }
  }
}