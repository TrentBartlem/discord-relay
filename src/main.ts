import {Comment, Devvit, Post, Subreddit, TriggerContext} from '@devvit/public-api';

Devvit.configure({
    redditAPI: true,
    http: true,
    redis: true
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
        }
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
        label: 'Filter by username(s)/moderators',
        fields: [
            {
                type: 'boolean',
                name: 'only-specific-user',
                label: 'Relay posts made by a specific user?',
            },
            {
                type: 'string',
                name: 'specific-username',
                label: 'Username (without the "u/") or enter "m" for all moderators. Separate each item with a comma to include multiple users.',
            },
        ],
    },
]);

// Logging on a PostSubmit event
Devvit.addTrigger({
    events: ['PostSubmit', 'CommentCreate'],
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
        settings
    } = context;
    const {
        type: eventType,
        author: {
            name: authorName,
            url: authorUrl
        },
        comment,
        post
    } = event;
    let item: Post | Comment;
    let itemType: string;
    if (eventType === 'PostSubmit') {
        item = post
        itemType = "post";
    } else {
        item = comment
        itemType = "comment";
    }
    const webhookUrl = (await settings.get('webhook-url'))!.toString();
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
                "everyone"
            ],
        }
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
        settings
    } = context;
    const subreddit: Subreddit = await reddit.getCurrentSubreddit()
    const {
        type: eventType,
        author: {
            name: authorName,
        },
    } = event;
    let itemType: string;
    const contentType = await settings.get('content-type');
    if (eventType === 'PostSubmit') {
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
    shouldRelay = shouldRelay && !(await redis.get(item.id) === 'true');
    if (shouldRelay) {
        // @ts-ignore
        const username: string = await settings.get('specific-username');
        if (username) {
            const usernames = username.toLowerCase().split(',').map(name => name.trim());
            shouldRelay = usernames.includes(authorName.toLowerCase());
            if (!shouldRelay && usernames.includes('m')) {
                shouldRelay = (await subreddit.getModerators({username: authorName}).all()).length > 0;
            }
        }
    }
    console.log(`Should relay event: ${shouldRelay}`);
    return shouldRelay;
}

export default Devvit;
