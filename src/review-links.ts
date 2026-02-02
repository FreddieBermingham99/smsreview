import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

export interface ReviewLink {
  city: string;
  stashpoint_name?: string;
  google_review_url: string;
}

export type ReviewLinksMap = Map<string, ReviewLink[]>;

let reviewLinksMap: ReviewLinksMap | null = null;
let csvFilePath: string | null = null;

/**
 * Load review links from CSV file
 * Expected CSV format: city, stashpoint_name (optional), google_review_url
 */
export function loadReviewLinks(csvPath: string): ReviewLinksMap {
  if (!fs.existsSync(csvPath)) {
    console.warn(`[REVIEW-LINKS] CSV file not found: ${csvPath}`);
    return new Map();
  }

  const fileContent = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const map = new Map<string, ReviewLink[]>();

  for (const record of records) {
    const city = record.city?.trim();
    const url = record.google_review_url?.trim();

    if (!city || !url) {
      console.warn(`[REVIEW-LINKS] Skipping invalid row: missing city or URL`, record);
      continue;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      console.warn(`[REVIEW-LINKS] Skipping invalid URL: ${url}`);
      continue;
    }

    const reviewLink: ReviewLink = {
      city: city.toLowerCase(), // Normalize to lowercase for matching
      stashpoint_name: record.stashpoint_name?.trim() || undefined,
      google_review_url: url,
    };

    if (!map.has(reviewLink.city)) {
      map.set(reviewLink.city, []);
    }
    map.get(reviewLink.city)!.push(reviewLink);
  }

  console.log(`[REVIEW-LINKS] Loaded ${records.length} review links for ${map.size} cities`);
  return map;
}

/**
 * Get review links map (loads on first call if not already loaded)
 */
export function getReviewLinksMap(): ReviewLinksMap {
  if (!reviewLinksMap) {
    const csvPath = process.env.REVIEW_LINKS_CSV || path.join(process.cwd(), 'data', 'review-links.csv');
    csvFilePath = csvPath;
    reviewLinksMap = loadReviewLinks(csvPath);
  }
  return reviewLinksMap;
}

/**
 * Reload review links from CSV file
 */
export function reloadReviewLinks(): ReviewLinksMap {
  const csvPath = csvFilePath || process.env.REVIEW_LINKS_CSV || path.join(process.cwd(), 'data', 'review-links.csv');
  csvFilePath = csvPath;
  reviewLinksMap = loadReviewLinks(csvPath);
  return reviewLinksMap;
}

/**
 * Get a random review URL for a city
 * Falls back to London if city has no links
 */
export function getRandomReviewUrl(city: string, fallbackToLondon: boolean = true): string | null {
  const map = getReviewLinksMap();
  const normalizedCity = city.toLowerCase().trim();
  let links = map.get(normalizedCity);

  // Fallback to London if no links for this city
  if ((!links || links.length === 0) && fallbackToLondon) {
    links = map.get('london');
  }

  if (!links || links.length === 0) {
    return null;
  }

  // Pick random URL from the city's list (or London fallback)
  const randomIndex = Math.floor(Math.random() * links.length);
  return links[randomIndex].google_review_url;
}

/**
 * Check if a city has review links available
 */
export function hasReviewLinks(city: string): boolean {
  const map = getReviewLinksMap();
  const normalizedCity = city.toLowerCase().trim();
  return map.has(normalizedCity) && (map.get(normalizedCity)?.length || 0) > 0;
}

