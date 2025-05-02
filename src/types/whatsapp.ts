type WhatsAppMessageData = {
    integrationId: string;
    to: string;
    // Use the specific union type required by the function
    type: "text" | "template" | "image" | "document" | "interactive";
    // Make properties optional (?) if they aren't always present
    text?: {
        body: string;
        preview_url?: boolean;
    };
    template?: { /* structure for template messages */ name: string; language: { code: string; }; components?: any[]; };
    image?: { /* structure for image messages */ link: string; caption?: string; } | { id: string; caption?: string; };
    document?: { /* structure for document messages */ link: string; caption?: string; filename?: string; } | { id: string; caption?: string; filename?: string; };
    interactive?: any; // Define more specifically if possible
    internalMessageId?: string;
  };