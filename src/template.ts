import * as fs from 'fs';
import * as path from 'path';

export interface TemplateVariables {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  stashpointName?: string;
  reviewUrl?: string;
  city?: string;
  bookingId?: string | number;
}

const TEMPLATE_FILE = path.join(process.cwd(), 'data', 'sms-template.txt');
const DEFAULT_TEMPLATE = `Thanks for using Stasher at {stashpointName} yesterday 🙌 Would you mind leaving a quick Google review? {reviewUrl} Reply STOP to opt out.`;

/**
 * Load SMS template from file, or return default
 */
export function loadTemplate(): string {
  const templatePath = TEMPLATE_FILE;
  
  if (!fs.existsSync(templatePath)) {
    // Create default template file
    const dataDir = path.dirname(templatePath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(templatePath, DEFAULT_TEMPLATE, 'utf-8');
    return DEFAULT_TEMPLATE;
  }

  try {
    return fs.readFileSync(templatePath, 'utf-8').trim();
  } catch (error) {
    console.error('[TEMPLATE] Error loading template:', error);
    return DEFAULT_TEMPLATE;
  }
}

/**
 * Save SMS template to file
 */
export function saveTemplate(template: string): void {
  const templatePath = TEMPLATE_FILE;
  const dataDir = path.dirname(templatePath);
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  fs.writeFileSync(templatePath, template, 'utf-8');
}

/**
 * Render template with variables
 */
export function renderTemplate(template: string, vars: TemplateVariables): string {
  let rendered = template;
  
  // Replace variables: {variableName}
  const variableMap: Record<string, string> = {
    firstName: vars.firstName || '',
    lastName: vars.lastName || '',
    fullName: vars.fullName || `${vars.firstName || ''} ${vars.lastName || ''}`.trim() || '',
    stashpointName: vars.stashpointName || '',
    reviewUrl: vars.reviewUrl || '',
    city: vars.city || '',
    bookingId: vars.bookingId ? String(vars.bookingId) : '',
  };
  
  for (const [key, value] of Object.entries(variableMap)) {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    rendered = rendered.replace(regex, value);
  }
  
  return rendered;
}

/**
 * Get available variables for documentation
 */
export function getAvailableVariables(): string[] {
  return ['firstName', 'lastName', 'fullName', 'stashpointName', 'reviewUrl', 'city', 'bookingId'];
}

