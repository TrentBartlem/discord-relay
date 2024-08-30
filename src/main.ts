import {ModAction} from "@devvit/protos";
import {
    Comment,
    Devvit,
    Post,
    SettingsFormFieldValidatorEvent,
    Subreddit,
    TriggerContext,
    User,
} from "@devvit/public-api";

const MINIMUM_DELAY = 3;
const RELAY_SCHEDULED_JOB = "relay";

Devvit.configure({
    http: true,
    redditAPI: true,
    redis: true,
});

function isRemoved(target: Comment | Post) {
    console.log(`isRemoved attrs ${JSON.stringify(target, null, 2)}`);
    return target.spam
        || target.removed
        // @ts-ignore
        || target.removedByCategory
        === "automod_filtered"
        // @ts-ignore
        || target.bannedBy
        === "AutoModerator"
        // @ts-ignore
        || target.bannedBy?.toString()
        === "true"
        // @ts-ignore
        || target.removalReason
        === "legal";
}

Devvit.addSchedulerJob({
    name: RELAY_SCHEDULED_JOB,
    onRun: async (event, context) => {
        const {reddit, settings} = context;
        const {
            data,
            itemId,
            itemType,
            uniqueId,
            webhookUrl,
        } = event.data!;
        let item;
        item = itemType === "post" ? await reddit.getPostById(itemId) : await reddit.getCommentById(itemId);
        if (await settings.get("ignore-removed") && isRemoved(item)) {
            console.log(`Not relaying due to item removed: ${uniqueId}`);
            return
        }
        console.log(`Relaying event ${uniqueId}`);
        await relay(context, item, webhookUrl, data);
    },
});

Devvit.addSettings([
    {
        label: "Discord Webhook URL",
        name: "webhook-url",
        onValidate: (event) => {
            if (event.value!.length == 0) {
                return "Please enter a webhook URL"
            }
        },
        type: "string",
    },
    {
        helpText: "If enabled, a role will be pinged when a new comment or post is relayed to Discord.",
        fields: [
            {
                type: "boolean",
                name: "ping-role",
                label: "Ping a role?",
            },
            {
                type: "string",
                name: "ping-role-id",
                label: "Role ID",
            },
        ],
        label: "Role Ping settings",
        type: "group",
    },
    {
        fields: [
            {
                helpText: "Type of content to relay to Discord",
                label: "Content Type",
                multiSelect: false,
                name: "content-type",
                defaultValue: ["post"],
                options: [
                    {
                        label: "All",
                        value: "all",
                    },
                    {
                        label: "Posts Only",
                        value: "post",
                    },
                    {
                        label: "Comments Only",
                        value: "comment",
                    },
                ],
                type: "select",
            },
            {
                fields: [
                    {
                        helpText: "Only relay items from specific users or moderators. Username (without the \"u/\") or enter \"m\" for all moderators. Separate each item with a comma to include multiple users",
                        label: "Username(s)/Moderators Only",
                        name: "specific-username",
                        type: "string",
                    },
                    {
                        helpText: "User flair text to match against. Separate each item with a comma to include multiple flairs.",
                        label: "User Flair Text",
                        name: "user-flair",
                        type: "string",
                    },
                    {
                        helpText: "Post flair text to match against. Separate each item with a comma to include multiple flairs.",
                        label: "Post Flair Text",
                        name: "post-flair",
                        type: "string",
                    },
                ],
                helpText: "Relay items by username(s)/moderators or post/user flairs. If any of these settings match, the item will be relayed.",
                label: "Inclusion Filters",
                type: "group",
            },
            {
                fields: [
                    {
                        helpText: "Ignore items from specific users or moderators. Username (without the \"u/\") or enter \"m\" for all moderators. Separate each item with a comma to include multiple users.",
                        label: "Username(s)/Moderators Only",
                        name: "ignore-specific-username",
                        type: "string",
                    },
                    {
                        helpText: "User flair text to ignore. Separate each item with a comma to include multiple flairs.",
                        label: "User Flair Text",
                        name: "ignore-user-flair",
                        type: "string",
                    },
                    {
                        helpText: "Post flair text to ignore. Separate each item with a comma to include multiple flairs.",
                        label: "Post Flair Text",
                        name: "ignore-post-flair",
                        type: "string",
                    },
                ],
                helpText: "Ignore by username(s)/moderators or post/user flairs. Takes precedence over all other settings. If any of these settings match, the item will not be relayed.",
                label: "Exclusion Filters",
                type: "group",
            },
        ],
        helpText: "Filter items to relay to Discord based on specific criteria.",
        label: "Filtering Settings",
        type: "group",
    },
    {
        fields: [
            {
                defaultValue: 0,
                helpText: `Number of minutes to delay relaying comments to Discord. Enter 0 to disable the delay. Must be at least ${MINIMUM_DELAY} minutes.`,
                label: "Comment Delay (in minutes)",
                name: "comment-delay",
                onValidate: validateDelay,
                type: "number",
            },
            {
                defaultValue: 0,
                helpText: `Number of minutes to delay relaying posts to Discord. Enter 0 to disable the delay. Must be at least ${MINIMUM_DELAY} minutes.`,
                label: "Post Delay (in minutes)",
                name: "post-delay",
                onValidate: validateDelay,
                type: "number",
            },
            {
                helpText: "If enabled, items will not be relayed if they are removed.",
                label: "Ignore Removed Items",
                name: "ignore-removed",
                type: "boolean",
            },
            {
                helpText: "If enabled, items that are later approved will be relayed.",
                label: "Retry On Approval",
                name: "retry-on-approval",
                type: "boolean",
            },
        ],
        helpText: "Delay relaying to Discord for a set amount of time after the item is created to allow for moderation.",
        label: "Delay Settings",
        type: "group",
    },
]);

Devvit.addTrigger({
    events: ["CommentCreate", "PostCreate"],
    onEvent: async function (
        event: any,
        context: TriggerContext,
    ) {
        const {reddit, redis} = context;
        const uniqueId = event.type === "CommentCreate"
            ? `${event.comment.parentId}/${event.comment.id}`
            : event.post.id;
        const item = event.type === "CommentCreate"
            ? await reddit.getCommentById(event.comment.id)
            : await reddit.getPostById(event.post.id);
        console.log(`Received ${event.type} event (${uniqueId}) by u/${item.authorName}`);
        const shouldRelayItem = await shouldRelay(event, context);
        await redis.hSet(item.id, {shouldRelay: shouldRelayItem.toString()});
        if (shouldRelayItem) {
            await scheduleRelay(context, item, false);
        }
    },
});

Devvit.addTrigger({
    events: ["ModAction"],
    onEvent: async function (event: ModAction, context: TriggerContext) {
        const {reddit, redis, settings} = context;
        if ((
            event.action != "approvelink" && event.action != "approvecomment"
        )) {
            return;
        }
        const retryOnApproval = await settings.get("retry-on-approval");
        if (!retryOnApproval) {
            return;
        }
        let target: Comment | Post;
        let uniqueId: string;
        if (event.action == "approvelink") {
            target = await reddit.getPostById(event.targetPost?.id || "");
            uniqueId = target.id;
        } else {
            target = await reddit.getCommentById(event.targetComment?.id || "");
            uniqueId = `${target.parentId}/${target.id}`
        }
        console.log(`Received ${event.action} mod action (${uniqueId})`);
        const shouldRelayItem = await redis.hGet(target.id, "shouldRelay") === "true";
        const wasRelayed = await redis.hGet(target.id, "relayed") === "true";
        if (shouldRelayItem && !wasRelayed) {
            await scheduleRelay(context, target, true);
        } else {
            console.log(`Not relaying ${event.action} mod action (${uniqueId}) due to shouldRelayItem: ${shouldRelayItem} and wasRelayed: ${wasRelayed}`);
        }
    },
});

async function relay(
    context: TriggerContext,
    item: Comment | Post,
    webhookUrl: string,
    data: { allowed_mentions: { parse: string[] }; content: string },
) {
    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
    })
    console.log(`Webhook response: ${response.status} ${await response.text()}`);
    await context.redis.hSet(item.id, {relayed: "true"});
}

async function scheduleRelay(context: TriggerContext, item: Comment | Post, skipDelay: boolean) {
    const {
        redis,
        settings,
    } = context;
    const webhookUrl = (
        await settings.get("webhook-url")
    )!.toString();
    const {url: authorUrl, username} = await item.getAuthor() as User;
    const itemType = item instanceof Comment ? "comment" : "post";
    const uniqueId = item instanceof Comment ? `${item.parentId}/${item.id}` : item.id;
    let delay: number = skipDelay ? 0 : await settings.get(`${itemType}-delay`) || 0;
    let message = `New [${itemType}](https://www.reddit.com${item.permalink}) by [u/${username}](${authorUrl})!`
    if (await settings.get("ping-role")) {
        const roleId = await settings.get("ping-role-id");
        message = `${message}\n<@&${roleId}>`
    }
    const data = {
        content: message,
        "allowed_mentions": {
            "parse": [
                "roles",
                "users",
                "everyone",
            ],
        },
    }
    if (delay == 0) {
        console.log(`Relaying event ${uniqueId}`);
        if (await settings.get("ignore-removed") && isRemoved(item)) {
            console.log(`Not relaying due to item removed: ${uniqueId}`);
            return
        }
        await relay(context, item, webhookUrl, data);
    } else {
        const runAt = new Date(Date.now() + delay * 60 * 1000)
        console.log(`Scheduling relay (${uniqueId}) for ${delay} minutes from now (${runAt})`);
        if (await redis.hGet(item.id, "scheduled") === "true") {
            console.log(`Relay job already scheduled for ${uniqueId}`);
            return
        }
        await context.scheduler.runJob({
            name: RELAY_SCHEDULED_JOB,
            data: {
                data,
                itemType,
                itemId: item.id,
                uniqueId,
                webhookUrl,
            },
            runAt: runAt,
        });
    }
    await redis.hSet(item.id, {scheduled: "true"});
}

async function shouldRelay(event: any, context: TriggerContext): Promise<boolean> {
    let itemType: string;
    let item: Post | Comment;
    const {
        type: eventType,
        author: {
            name: authorName,
        },
    } = event;
    if (eventType === "PostCreate") {
        item = event.post
        itemType = "post"
    } else {
        item = event.comment
        itemType = "comment"
    }
    console.log(`Checking if we should relay event (${item instanceof Comment
        ? `${item.parentId}/${item.id}`
        : item.id})`);
    const {
        reddit,
        redis,
        settings,
    } = context;
    const subreddit: Subreddit = await reddit.getCurrentSubreddit()

    const flairMap = new Map<string, string>();

    const ignoreFlair: string = await settings.get("ignore-user-flair") || "";
    const userFlair: string = await settings.get("user-flair") || "";
    if (ignoreFlair || userFlair) {
        const userFlairs = (
            await subreddit.getUserFlairTemplates()
        )
        for (const flair of userFlairs) {
            flairMap.set(flair.id, flair.text);
        }
    }

    const ignorePostFlair: string = await settings.get("ignore-post-flair") || "";
    const postFlair: string = await settings.get("post-flair") || "";
    if (ignorePostFlair || postFlair) {
        const postFlairs = await subreddit.getPostFlairTemplates()
        for (const flair of postFlairs) {
            flairMap.set(flair.id, flair.text);
        }
    }
    const contentType = await settings.get("content-type");
    let shouldRelay = contentType == "all" || contentType == itemType;
    shouldRelay = shouldRelay && !(
        await redis.hGet(item.id, "relayed") === "true"
    );
    let checks: boolean[] = []
    if (shouldRelay) {
        const ignoreUsername: string = await settings.get("ignore-specific-username") || "";
        if (ignoreUsername) {
            let shouldRelayUserIgnore: boolean;
            const ignoreUsernames = ignoreUsername.toLowerCase()
                .split(",")
                .map(name => name.trim())
                .filter(name => name.length > 0);
            shouldRelayUserIgnore = !ignoreUsernames.includes(authorName.toLowerCase());
            if (shouldRelayUserIgnore && ignoreUsernames.includes("m")) {
                shouldRelayUserIgnore = (
                    await subreddit.getModerators({username: authorName}).all()
                ).length == 0;
            }
            if (!shouldRelayUserIgnore) {
                console.log(`Should relay event (shouldRelayUserIgnore): ${shouldRelayUserIgnore}`);
                return false;
            }
        }
        if (ignoreFlair) {
            let shouldRelayUserFlair: boolean;
            const ignoreFlairs = ignoreFlair.toLowerCase()
                .split(",")
                .map(flair => flair.trim())
                .filter(flair => flair.length > 0);
            shouldRelayUserFlair = !(
                ignoreFlairs.includes(event.author.flair.text.toLowerCase())
                || ignoreFlairs.includes(flairMap.get(event.author.flair.templateId) || "")
            );
            if (!shouldRelayUserFlair) {
                console.log(`Should relay event (shouldRelayUserFlair): ${shouldRelayUserFlair}`);
                return false;
            }
        }
        if (ignorePostFlair && itemType === "post") {
            let shouldRelayPostFlair: boolean;
            const ignorePostFlairs = ignorePostFlair.toLowerCase()
                .split(",")
                .map(flair => flair.trim())
                .filter(flair => flair.length > 0);
            shouldRelayPostFlair = !(
                ignorePostFlairs.includes(event.post.linkFlair.text.toLowerCase())
                || ignorePostFlairs.includes(flairMap.get(event.post.linkFlair.templateId
                    || "") || "")
            );
            if (!shouldRelayPostFlair) {
                console.log(`Should relay event (shouldRelayPostFlair): ${shouldRelayPostFlair}`);
                return false;
            }
        }
        const username: string = await settings.get("specific-username") || "";
        if (username) {
            const usernames = username.toLowerCase()
                .split(",")
                .map(name => name.trim())
                .filter(name => name.length > 0);
            shouldRelay = usernames.includes(authorName.toLowerCase());
            if (!shouldRelay && usernames.includes("m")) {
                shouldRelay = (
                    await subreddit.getModerators({username: authorName}).all()
                ).length > 0;
            }
            checks.push(shouldRelay);
        }
        if (userFlair) {
            const userFlairs = userFlair.toLowerCase()
                .split(",")
                .map(flair => flair.trim())
                .filter(flair => flair.length > 0);
            shouldRelay = userFlairs.includes(event.author.flair.text.toLowerCase())
                || userFlairs.includes(flairMap.get(event.author.flair.templateId) || "");
            checks.push(shouldRelay);
        }
        if (postFlair && itemType === "post") {
            const postFlairs = postFlair.toLowerCase()
                .split(",")
                .map(flair => flair.trim())
                .filter(flair => flair.length > 0);
            if (item instanceof Post) {
                shouldRelay = postFlairs.includes(item.flair && item.flair.text
                    ? item.flair.text.toLowerCase() : "") || postFlairs.includes(flairMap.get(item.flair?.templateId
                    || "") || "");
            }
            checks.push(shouldRelay);
        }
    }
    if (checks.length == 0) {
        console.log(`Should relay event: ${shouldRelay}`);
        return shouldRelay;
    }
    shouldRelay = checks.includes(true)
    console.log(`Should relay event: ${shouldRelay}`);
    return shouldRelay;
}

function validateDelay(event: SettingsFormFieldValidatorEvent<number>) {
    const inputValue = event.value || 0
    if (inputValue != 0 && inputValue < MINIMUM_DELAY) {
        return `Please enter a delay of at least ${MINIMUM_DELAY} minutes`
    }
}

// noinspection JSUnusedGlobalSymbols
export default Devvit;
