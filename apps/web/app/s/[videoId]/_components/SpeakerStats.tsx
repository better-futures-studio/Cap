import type { MeetingSpeakerStats } from "@cap/database/types";

interface SpeakerStatsProps {
	stats: MeetingSpeakerStats;
	className?: string;
}

const formatDuration = (seconds: number) => {
	const minutes = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return `${minutes}:${secs.toString().padStart(2, "0")}`;
};

const SpeakerStats = ({ stats, className }: SpeakerStatsProps) => {
	if (stats.speakers.length === 0) return null;

	return (
		<div className={className}>
			<h3 className="mb-2 text-lg font-medium">Speakers</h3>
			<div className="space-y-3">
				{stats.speakers.map((speaker) => (
					<div key={speaker.name}>
						<div className="flex justify-between items-center text-sm">
							<span>{speaker.name}</span>
							<span className="text-gray-10">
								{Math.round(speaker.share * 100)}% ·{" "}
								{formatDuration(speaker.speakingSeconds)}
							</span>
						</div>
						<div className="mt-1 h-1.5 bg-gray-3 rounded-full overflow-hidden">
							<div
								className="h-full bg-gray-8 rounded-full"
								style={{ width: `${Math.round(speaker.share * 100)}%` }}
							/>
						</div>
						<p className="mt-1 text-xs text-gray-10">
							{speaker.turns} turns · {speaker.questions} questions · longest
							monologue {formatDuration(speaker.longestMonologueSeconds)}
						</p>
					</div>
				))}
			</div>
		</div>
	);
};

export default SpeakerStats;
