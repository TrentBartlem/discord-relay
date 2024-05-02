import {Comment, Devvit, Post, Subreddit, TriggerContext} from '@devvit/public-api';

Devvit.configure({
    redditAPI: true,
    http: true,
    redis: true,
});

Devvit.addSettings([
    {
        type: 'string',
        name: 'webhook-url',
        label: 'Discord Webhook URL:',
        onValidate: (event) => {
            if (event.value!.length == 0) {
                return 'Please enter a webhook URL'
            }
        },
    },
    {
        type: 'group',
        label: 'Role Ping settings',
        fields: [
            {
                type: 'boolean',
                name: 'ping-role',
                label: 'Ping a role?',
            },
            {
                type: 'string',
                name: 'ping-role-id',
                label: 'Role ID:',
            },
        ],
    },
    {
        type: 'select',
        name: 'content-type',
        label: 'Content type',
        options: [
            {
                label: 'Posts Only',
                value: 'post',
            },
            {
                label: 'Comments Only',
                value: 'comment',
            },
            {
                label: 'All',
                value: 'all',
            },
        ],
        multiSelect: false,
    },
    {
        type: 'group',
        label: 'Relay items by username(s)/moderators or post/user flairs. If any of these settings match, the item will be relayed.',
        fields: [
            {
                type: 'string',
                name: 'specific-username',
                label: 'Username (without the "u/") or enter "m" for all moderators. Separate each item with a comma to include multiple users.',
            },
            {
                type: 'string',
                name: 'user-flair',
                label: 'User flair text to match against. Separate each item with a comma to include multiple flairs.',
            },
            {
                type: 'string',
                name: 'post-flair',
                label: 'Post flair text to match against. Separate each item with a comma to include multiple flairs.',
            },
        ],
    },
    {
        type: 'group',
        label: 'Ignore by username(s)/moderators or post/user flairs. Takes precedence over all other settings. If any of these settings match, the item will not be relayed.',
        fields: [
            {
                type: 'string',
                name: 'ignore-specific-username',
                label: 'Username (without the "u/") or enter "m" to ignore all moderators. Separate each item with a comma to include multiple users.',
            },
            {
                type: 'string',
                name: 'ignore-user-flair',
                label: 'User flair text to ignore. Separate each item with a comma to include multiple flairs.',
            },
            {
                type: 'string',
                name: 'ignore-post-flair',
                label: 'Post flair text to ignore. Separate each item with a comma to include multiple flairs.',
            },
        ],
    },
]);

// Logging on a PostCreate event
Devvit.addTrigger({
    events: ['PostCreate', 'CommentCreate'],
    onEvent: async function (event: any, context: TriggerContext) {
        console.log(`Received ${event.type} event:\n${JSON.stringify(event)}`);
        if (await shouldRelay(event, context)) {
            await relay(event, context);
        }
    },
});

async function relay(event: any, context: TriggerContext) {
    console.log(`Relaying event:\n${JSON.stringify(event)}`);
    const {
        redis,
        settings,
    } = context;
    const {
        type: eventType,
        author: {
            name: authorName,
            url: authorUrl,
        },
        comment,
        post,
    } = event;
    let item: Post | Comment;
    let itemType: string;
    if (eventType === 'PostCreate') {
        item = post
        itemType = "post";
    } else {
        item = comment
        itemType = "comment";
    }
    const webhookUrl = (
        await settings.get('webhook-url')
    )!.toString();
    let message = `New [${itemType}](https://www.reddit.com${item.permalink}) by [u/${authorName}](${authorUrl})!`
    if (await settings.get('ping-role')) {
        const roleId = await settings.get('ping-role-id');
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
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
    })
    await redis.set(item.id, 'true');
    console.log(`Webhook response: ${response.status} ${await response.text()}`);
}

async function shouldRelay(event: any, context: TriggerContext): Promise<boolean> {
    console.log(`Checking if we should relay event:\n${JSON.stringify(event)}`);
    const {
        redis,
        reddit,
        settings,
    } = context;
    const subreddit: Subreddit = await reddit.getCurrentSubreddit()
    const userFlairs = (
        await subreddit.getUserFlairTemplates()
    )
    const flairMap = new Map<string, string>();
    for (const flair of userFlairs) {
        flairMap.set(flair.id, flair.text);
    }
    const postFlairs = await subreddit.getPostFlairTemplates()
    for (const flair of postFlairs) {
        flairMap.set(flair.id, flair.text);
    }
    const {
        type: eventType,
        author: {
            name: authorName,
        },
    } = event;
    let itemType: string;
    const contentType = await settings.get('content-type');
    if (eventType === 'PostCreate') {
        itemType = 'post'
    } else {
        itemType = 'comment'
    }
    let shouldRelay = contentType == 'all' || contentType == itemType;
    let item: Post | Comment;
    if (itemType === 'post') {
        item = event.post
    } else {
        item = event.comment
    }
    shouldRelay = shouldRelay && !(
        await redis.get(item.id) === 'true'
    );
    let checks: boolean[] = []
    if (shouldRelay) {
        // @ts-ignore
        const ignoreUsername: string = await settings.get('ignore-specific-username');
        if (ignoreUsername) {
            let shouldRelayUserIgnore: boolean;
            const ignoreUsernames = ignoreUsername.toLowerCase()
                .split(',')
                .map(name => name.trim())
                .filter(name => name.length > 0);
            shouldRelayUserIgnore = !ignoreUsernames.includes(authorName.toLowerCase());
            if (shouldRelayUserIgnore && ignoreUsernames.includes('m')) {
                shouldRelayUserIgnore = (
                    await subreddit.getModerators({username: authorName}).all()
                ).length == 0;
            }
            if (!shouldRelayUserIgnore) {
                console.log(`Should relay event (shouldRelayUserIgnore): ${shouldRelayUserIgnore}`);
                return false;
            }
        }
        // @ts-ignore
        const ignoreFlair: string = await settings.get('ignore-user-flair');
        if (ignoreFlair) {
            let shouldRelayUserFlair: boolean;
            const ignoreFlairs = ignoreFlair.toLowerCase()
                .split(',')
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
        // @ts-ignore
        const ignorePostFlair: string = await settings.get('ignore-post-flair');
        if (ignorePostFlair && itemType === 'post') {
            let shouldRelayPostFlair: boolean;
            const ignorePostFlairs = ignorePostFlair.toLowerCase()
                .split(',')
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

        // @ts-ignore
        const username: string = await settings.get('specific-username');
        if (username) {
            const usernames = username.toLowerCase()
                .split(',')
                .map(name => name.trim())
                .filter(name => name.length > 0);
            shouldRelay = usernames.includes(authorName.toLowerCase());
            if (!shouldRelay && usernames.includes('m')) {
                shouldRelay = (
                    await subreddit.getModerators({username: authorName}).all()
                ).length > 0;
            }
            checks.push(shouldRelay);
        }
        // @ts-ignore
        const userFlair: string = await settings.get('user-flair');
        if (userFlair) {
            const userFlairs = userFlair.toLowerCase()
                .split(',')
                .map(flair => flair.trim())
                .filter(flair => flair.length > 0);
            shouldRelay = userFlairs.includes(event.author.flair.text.toLowerCase())
                || userFlairs.includes(flairMap.get(event.author.flair.templateId) || "");
            checks.push(shouldRelay);
        }
        // @ts-ignore
        const postFlair: string = await settings.get('post-flair');
        if (postFlair && itemType === 'post') {
            const postFlairs = postFlair.toLowerCase()
                .split(',')
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

export default Devvit;
