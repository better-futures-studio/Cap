#!/bin/sh
# Railway cron entry point. Checks MySQL for pending recovery work and only
# calls Cap Web's recovery endpoints when something needs attention, so an
# idle Cap Web stays asleep. A full run is forced once an hour as a safety net.
set -eu

: "${WEB_URL:?}" "${CRON_SECRET:?}" "${MYSQLHOST:?}" "${MYSQLUSER:?}" "${MYSQLPASSWORD:?}" "${MYSQLDATABASE:?}"
MYSQLPORT="${MYSQLPORT:-3306}"

query() {
	MYSQL_PWD="$MYSQLPASSWORD" mysql --skip-ssl-verify-server-cert -h "$MYSQLHOST" -P "$MYSQLPORT" -u "$MYSQLUSER" -D "$MYSQLDATABASE" -N -B -e "$1" 2>&1 | tr -d '[:space:]' | cut -c1-200
}

call() {
	echo "calling $1"
	curl -fsS --retry 3 --retry-delay 10 --retry-all-errors --max-time 300 \
		-H "Authorization: Bearer $CRON_SECRET" "$WEB_URL/api/cron/$1"
	echo
}

force=0
if [ "$(date -u +%M)" -lt 15 ]; then force=1; fi

video_work=$(query "
SELECT
  (SELECT COUNT(*) FROM video_uploads
     WHERE phase = 'error'
        OR (phase = 'processing' AND updated_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR))
+ (SELECT COUNT(*) FROM videos v
     WHERE v.isScreenshot = 0
       AND v.updatedAt < UTC_TIMESTAMP() - INTERVAL 1 HOUR
       AND NOT EXISTS (SELECT 1 FROM video_uploads vu WHERE vu.video_id = v.id)
       AND (
            (v.transcriptionStatus IN ('PROCESSING') OR v.transcriptionStatus IS NULL)
            AND v.createdAt > UTC_TIMESTAMP() - INTERVAL 48 HOUR
         OR (JSON_EXTRACT(v.metadata, '$.summary') IS NULL
             AND (v.transcriptionStatus = 'COMPLETE' OR v.transcriptionStatus = 'NO_AUDIO' OR v.transcriptionStatus IS NULL)
             AND (JSON_UNQUOTE(JSON_EXTRACT(v.metadata, '$.aiGenerationStatus')) IS NULL
                  OR JSON_UNQUOTE(JSON_EXTRACT(v.metadata, '$.aiGenerationStatus')) IN ('QUEUED','PROCESSING'))
             AND (v.duration IS NULL OR v.duration >= 5))
       ))
")

recall_work=$(query "
SELECT
  (SELECT COUNT(*) FROM meeting_bots
     WHERE status IN ('done','call_ended','transcribing')
       AND recallRecordingId IS NULL AND videoId IS NULL
       AND updatedAt < UTC_TIMESTAMP() - INTERVAL 15 MINUTE)
+ (SELECT COUNT(*) FROM meeting_bots
     WHERE status = 'scheduling' AND updatedAt < UTC_TIMESTAMP() - INTERVAL 15 MINUTE)
+ (SELECT COUNT(*) FROM meeting_bots
     WHERE status IN ('transcribing','complete') AND chatSyncedAt IS NULL
       AND videoId IS NOT NULL AND recallRecordingId IS NOT NULL)
+ (SELECT COUNT(*) FROM meeting_bots
     WHERE status = 'complete' AND recapSentAt IS NULL AND videoId IS NOT NULL
       AND createdAt > UTC_TIMESTAMP() - INTERVAL 3 DAY)
+ (SELECT COUNT(*) FROM meeting_bots
     WHERE source = 'calendar' AND attendeeEmails IS NULL AND calendarEventId IS NOT NULL
       AND joinAt > UTC_TIMESTAMP() - INTERVAL 30 DAY)
")

case "$video_work$recall_work" in
	*[!0-9]*|"") echo "pre-check failed: video='$video_work' recall='$recall_work'; running everything"; force=1 ;;
esac
echo "pending: video=${video_work:-?} recall=${recall_work:-?} force=$force"

if [ "$force" = 1 ] || [ "${video_work:-1}" != "0" ]; then
	call recover-failed-video-processing
	call finalize-stale-desktop-segments
elif [ "${recall_work:-1}" != "0" ]; then
	call recall-reconcile
else
	echo "nothing to do; leaving Cap Web asleep"
fi
