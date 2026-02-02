import { PoolClient } from 'pg';
import { SCHEMA } from '../config';

export interface HiveboxBookingRow {
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  booking_id: number;
  pickup: Date;
  stashpoint_name: string;
  city: string | null;
  access_code: string;
}

/**
 * Fetch Hivebox locker customers whose pickup time was in the previous hour
 * Query targets bookings that ended in the previous full hour window
 */
export async function getHiveboxPreviousHourPickups(client: PoolClient): Promise<HiveboxBookingRow[]> {
  const query = `
    SELECT
      u.first_name,
      u.last_name,
      u.phone_number,
      b.id              AS booking_id,
      b.pickup,
      sp.business_name  AS stashpoint_name,
      l.name            AS city,
      ssc.locker_code   AS access_code
    FROM bookings b
    -- customer
    JOIN customers c ON b.customer_id = c.id
    JOIN users u ON c.user_id = u.id
    -- storage space booking (critical join)
    JOIN storage_space_bookings ssb
      ON ssb.booking_id::text = b.id::text
    -- storage space
    JOIN storage_spaces ss
      ON ss.id = ssb.storage_space_id
    -- hivebox access codes
    JOIN storage_space_codes ssc
      ON ssc.storage_space_booking_id = ssb.id
    -- stashpoint (this is where Hivebox is identified)
    JOIN stashpoints sp
      ON ss.stashpoint_id = sp.id
    LEFT JOIN locations l
      ON sp.new_nearest_city_id = l.id
    WHERE
      sp.storage_type = 'hivebox_locker_bank'
      AND b.pickup >= date_trunc('hour', now()) - interval '1 hour'
      AND b.pickup <  date_trunc('hour', now())
      AND b.cancelled = false
      AND b.paid = true
      AND u.phone_number IS NOT NULL
      AND u.phone_number <> ''
  `;

  const result = await client.query(query);
  return result.rows;
}
