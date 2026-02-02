import * as dotenv from 'dotenv';

dotenv.config();

export interface SchemaConfig {
  bookings: {
    table: string;
    id: string;
    pickedUpAt: string;
    stashpointId: string;
    customerId: string;
  };
  customers: {
    table: string;
    id: string;
    userId: string;
  };
  users: {
    table: string;
    id: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
  };
  stashpoints: {
    table: string;
    id: string;
    businessName: string; // business_name field
    nearestCityId: string; // new_nearest_city_id field
  };
  locations: {
    table: string;
    id: string;
    name: string; // city name
  };
}

/**
 * Schema configuration - easily changeable if your actual schema differs
 */
export const SCHEMA: SchemaConfig = {
  bookings: {
    table: 'bookings',
    id: 'id',
    pickedUpAt: 'pickup',
    stashpointId: 'stashpoint_id',
    customerId: 'customer_id',
  },
  customers: {
    table: 'customers',
    id: 'id',
    userId: 'user_id',
  },
  users: {
    table: 'users',
    id: 'id',
    firstName: 'first_name',
    lastName: 'last_name',
    phoneNumber: 'phone_number',
  },
  stashpoints: {
    table: 'stashpoints',
    id: 'id',
    businessName: 'business_name',
    nearestCityId: 'new_nearest_city_id',
  },
  locations: {
    table: 'locations',
    id: 'id',
    name: 'name',
  },
};

/**
 * SMS message template - editable
 */
export const SMS_TEMPLATE = (firstName: string | null | undefined, reviewLink: string): string => {
  const name = firstName ? firstName.trim() : '';
  const greeting = name ? `Hi ${name}\n` : 'Hi\n';
  return `${greeting}Stasher would love your feedback! Leave a review here: ${reviewLink}`;
};

export const config = {
  // Database (read-only)
  databaseReadUrl: process.env.DATABASE_READ_URL || process.env.DATABASE_URL || '',
  
  // Review links CSV path
  reviewLinksCsv: process.env.REVIEW_LINKS_CSV || '',
  
  // TextMagic
  textmagic: {
    username: process.env.TEXTMAGIC_USERNAME || '',
    apiKey: process.env.TEXTMAGIC_API_KEY || '',
    sender: process.env.TEXTMAGIC_SENDER || '',
  },
  
  // Scheduler
  timezone: 'Europe/London',
  jobHour: 10,
  jobMinute: 0,
  
  // Rate limiting
  smsDelayMs: parseInt(process.env.SMS_DELAY_MS || '200', 10),
  
  // Runtime flags
  dryRun: process.env.DRY_RUN === 'true',
  runJob: process.env.RUN_JOB === 'true',
  
  // Webhook (use PORT when set by hosting platforms e.g. Railway, Render)
  webhookPort: parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '4010', 10),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
};

// Validation
if (!config.databaseReadUrl) {
  throw new Error('DATABASE_READ_URL (or DATABASE_URL) is required');
}

if (!config.dryRun && (!config.textmagic.username || !config.textmagic.apiKey)) {
  throw new Error('TEXTMAGIC_USERNAME and TEXTMAGIC_API_KEY are required when not in DRY_RUN mode');
}

