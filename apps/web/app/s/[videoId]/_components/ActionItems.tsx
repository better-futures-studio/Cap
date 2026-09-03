import type { MeetingActionItem } from "@cap/database/types";

interface ActionItemsProps {
	items: MeetingActionItem[];
	className?: string;
}

const ActionItems = ({ items, className }: ActionItemsProps) => {
	if (items.length === 0) return null;

	return (
		<div className={className}>
			<h3 className="mb-2 text-lg font-medium">Action items</h3>
			<div className="space-y-2">
				{items.map((item, index) => (
					<div
						key={`${item.text}-${index}`}
						className="flex items-start gap-2 text-sm"
					>
						<span className="mt-1 size-3 shrink-0 rounded-sm border border-gray-400" />
						<div>
							<span>{item.text}</span>
							{(item.owner || item.due) && (
								<p className="text-xs text-gray-10">
									{[item.owner, item.due].filter(Boolean).join(" · ")}
								</p>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
};

export default ActionItems;
