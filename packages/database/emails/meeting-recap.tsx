import { CAP_LOGO_URL } from "@cap/utils";
import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import Footer from "./components/Footer";

export function MeetingRecap({
	email = "",
	url = "",
	title = "",
	date = "",
	duration = "",
	summary = "",
	talkTime = "",
	actionItems = [],
	recapMode = "self",
	botName = "",
	organizationName = "",
}: {
	email: string;
	url: string;
	title: string;
	date: string;
	duration: string;
	summary: string;
	talkTime?: string | null;
	actionItems: { text: string; owner: string | null; due: string | null }[];
	recapMode: string;
	botName: string;
	organizationName: string;
}) {
	return (
		<Html>
			<Head />
			<Preview>Recap: {title}</Preview>
			<Tailwind>
				<Body className="mx-auto my-auto bg-gray-1 font-sans">
					<Container className="mx-auto my-10 max-w-[500px] rounded border border-solid border-gray-200 px-10 py-5">
						<Section className="mt-8">
							<Img
								src={CAP_LOGO_URL}
								width="40"
								height="40"
								alt="Cap"
								className="mx-auto my-0"
							/>
						</Section>
						<Heading className="mx-0 my-7 p-0 text-center text-xl font-semibold text-black">
							{title}
						</Heading>
						<Text className="text-sm leading-6 text-black">
							{date}
							{duration ? ` · ${duration}` : ""}
						</Text>
						<Text className="text-sm font-semibold leading-6 text-black">
							Summary
						</Text>
						<Text className="text-sm leading-6 text-black">{summary}</Text>
						{talkTime ? (
							<Text className="text-sm leading-6 text-black">{talkTime}</Text>
						) : null}
						{actionItems.length > 0 ? (
							<>
								<Text className="text-sm font-semibold leading-6 text-black">
									Action items
								</Text>
								{actionItems.map((item) => {
									const extras = [item.owner, item.due].filter(Boolean);
									return (
										<Text
											key={item.text}
											className="text-sm leading-6 text-black"
										>
											• {item.text}
											{extras.length > 0 ? ` (${extras.join(", ")})` : ""}
										</Text>
									);
								})}
							</>
						) : null}
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={url}
							>
								Watch the recording
							</Link>
						</Section>
						<Text className="text-sm leading-6 text-gray-600">
							Sent by {botName}
							{organizationName ? ` for ${organizationName}` : ""} because your
							recording preference is set to {recapMode}. Change it on the
							Meetings page.
						</Text>
						<Footer email={email} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
