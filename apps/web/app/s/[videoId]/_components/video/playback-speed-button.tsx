"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import { CheckIcon } from "lucide-react";
import {
	MediaActionTypes,
	type MediaState,
	useMediaDispatch,
} from "media-chrome/react/media-store";
import { useCallback, useState } from "react";
import { cn } from "@/app/lib/utils";
import {
	formatPlaybackSpeedLabel,
	PLAYBACK_SPEEDS,
} from "@/lib/playback-speed";
import { Button as PlayerButton } from "./button";
import {
	MediaPlayerTooltip,
	useMediaPlayer,
	useMediaPlayerControl,
} from "./media-player";

const selectPlaybackRate = (state: Partial<MediaState>) =>
	state.mediaPlaybackRate ?? 1;

export function PlaybackSpeedButton({ className }: { className?: string }) {
	const dispatch = useMediaDispatch();
	const mediaPlaybackRate = useMediaPlayer(selectPlaybackRate);
	const { mediaId, disabled, portalContainer, setMenuOpen } =
		useMediaPlayerControl();
	const [open, setOpen] = useState(false);

	const onOpenChange = useCallback(
		(next: boolean) => {
			setOpen(next);
			setMenuOpen(next);
		},
		[setMenuOpen],
	);

	const onSelectSpeed = useCallback(
		(rate: number) => {
			dispatch({
				type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
				detail: rate,
			});
			onOpenChange(false);
		},
		[dispatch, onOpenChange],
	);

	return (
		<DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
			<MediaPlayerTooltip tooltip="Playback speed" shortcut={["<", ">"]}>
				<DropdownMenuTrigger asChild>
					<PlayerButton
						type="button"
						aria-controls={mediaId}
						aria-label="Playback speed"
						aria-haspopup="menu"
						aria-expanded={open}
						disabled={disabled}
						variant="ghost"
						className={cn(
							"h-8 min-w-8 px-1.5 text-xs font-medium tabular-nums aria-[expanded=true]:bg-gray-12/20",
							className,
						)}
					>
						{formatPlaybackSpeedLabel(mediaPlaybackRate)}
					</PlayerButton>
				</DropdownMenuTrigger>
			</MediaPlayerTooltip>
			<DropdownMenuContent
				container={portalContainer}
				side="top"
				align="end"
				sideOffset={10}
				className="min-w-20 data-[side=top]:mb-3.5"
			>
				{PLAYBACK_SPEEDS.map((speed) => {
					const selected = speed === mediaPlaybackRate;
					return (
						<DropdownMenuItem key={speed} asChild>
							<button
								type="button"
								className="w-full justify-between"
								onClick={() => onSelectSpeed(speed)}
							>
								{formatPlaybackSpeedLabel(speed)}
								{selected && <CheckIcon />}
							</button>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
