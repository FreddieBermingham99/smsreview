import { config } from './config';

export interface SendSMSResult {
  messageId: string;
  phone?: string;
}

export interface SendSMSError {
  code: number;
  message: string;
}

const TEXTMAGIC_API_BASE = 'https://rest.textmagic.com/api/v2';

/**
 * Send an SMS via TextMagic REST API
 * Returns messageId on success, throws on error
 */
export async function sendSMS(to: string, message: string): Promise<SendSMSResult> {
  if (config.dryRun) {
    console.log(`[DRY RUN] Would send SMS to ${to}: ${message}`);
    return { messageId: `dry-run-${Date.now()}` };
  }

  try {
    // Create Basic Auth header
    const auth = Buffer.from(`${config.textmagic.username}:${config.textmagic.apiKey}`).toString('base64');
    
    // Prepare request body
    const body = new URLSearchParams({
      phones: to,
      text: message,
    });

    // Only add sender ID if it's configured and not empty
    // Note: Sender ID must be registered/verified in your TextMagic account
    if (config.textmagic.sender && config.textmagic.sender.trim() !== '') {
      body.append('from', config.textmagic.sender.trim());
    }

    // Make API request
    const response = await fetch(`${TEXTMAGIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { 
        message?: string; 
        errors?: Record<string, any>;
        validation_errors?: Record<string, any>;
      };
      
      // TextMagic returns validation errors in different formats
      let errorMessage = errorData.message || `HTTP ${response.status}: ${response.statusText}`;
      
      // Extract validation errors if present
      if (errorData.errors) {
        const errorParts: string[] = [];
        for (const [key, value] of Object.entries(errorData.errors)) {
          if (key === 'fields' && typeof value === 'object' && value !== null) {
            // Handle nested fields object
            const fieldErrors = Object.entries(value as Record<string, any>)
              .map(([field, msgs]) => {
                const msgList = Array.isArray(msgs) ? msgs.join(', ') : String(msgs);
                return `${field}: ${msgList}`;
              });
            errorParts.push(...fieldErrors);
          } else {
            const msgList = Array.isArray(value) ? value.join(', ') : String(value);
            errorParts.push(`${key}: ${msgList}`);
          }
        }
        if (errorParts.length > 0) {
          errorMessage = `${errorMessage} (${errorParts.join('; ')})`;
        }
      }
      
      if (errorData.validation_errors) {
        const validationDetails = Object.entries(errorData.validation_errors)
          .map(([field, messages]) => {
            const msgList = Array.isArray(messages) ? messages.join(', ') : String(messages);
            return `${field}: ${msgList}`;
          })
          .join('; ');
        errorMessage = `${errorMessage} (${validationDetails})`;
      }
      
      console.error('[TEXTMAGIC] API Error:', {
        status: response.status,
        statusText: response.statusText,
        errorData: JSON.stringify(errorData, null, 2),
        phone: to,
        messageLength: message.length,
        messagePreview: message.substring(0, 50) + '...',
      });
      
      throw {
        code: response.status,
        message: errorMessage,
        details: errorData,
      } as SendSMSError & { details?: any };
    }

    const data = await response.json() as { id?: number; href?: string };
    
    // TextMagic returns: { id: number, href: string, ... }
    const messageId = data.id?.toString() || data.href || 'unknown';

    return { messageId, phone: to };
  } catch (error: any) {
    // If it's already a SendSMSError, re-throw
    if (error.code && error.message) {
      throw error;
    }
    
    const errorMessage = error.message || 'Unknown error';
    const errorCode = error.code || 500;
    
    throw {
      code: errorCode,
      message: errorMessage,
    } as SendSMSError;
  }
}

/**
 * Rate-limited SMS sender with sequential processing
 */
export class RateLimitedSMS {
  private delayMs: number;

  constructor(delayMs: number = config.smsDelayMs) {
    this.delayMs = delayMs;
  }

  async send(to: string, message: string): Promise<SendSMSResult> {
    const result = await sendSMS(to, message);
    
    // Add delay after sending (except for dry run)
    if (!config.dryRun && this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
    
    return result;
  }
}

