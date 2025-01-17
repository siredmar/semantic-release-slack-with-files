const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');

module.exports = {
  async success(pluginConfig, context) {
    const { nextRelease, commits, logger } = context;
    const slackToken = process.env.SLACK_TOKEN;
    const slackChannel = process.env.SLACK_CHANNEL;

    if (!slackToken || !slackChannel) {
      throw new Error('SLACK_TOKEN or SLACK_CHANNEL is not set in the environment variables.');
    }

    const slackClient = new WebClient(slackToken);
    const assets = pluginConfig.assets || {};
    const includeChangelog = pluginConfig.changelog ?? false;
    const includeLastCommitText = pluginConfig.lastCommitText ?? false;
    const lastLine = pluginConfig.lastLine || '';  // New config for the last line
    const rawMessageTemplate = pluginConfig.message || `New release: ${nextRelease.version}`;

    let downloadLinks = [];

    // Helper function to replace placeholders
    const interpolateMessage = (template) => {
      return template
        .replace(/\$\{nextRelease\.version\}/g, nextRelease.version || '')
        .replace(/\$\{nextRelease\.notes\}/g, nextRelease.notes || '');
    };

    try {
      // Extract and clean the body of the latest commit
      let lastCommitBody = '';
      if (includeLastCommitText && commits.length > 0) {
        const lastCommitMessage = commits[0].message;

        const commitLines = lastCommitMessage
          .split('\n')
          .slice(1)
          .filter(line =>
            line.trim() !== '' &&
            !line.trim().toLowerCase().startsWith('signed-off-by:') &&
            !line.trim().toLowerCase().startsWith('co-authored-by:')
          );

        lastCommitBody = commitLines.join('\n').trim();
      }

      // Helper function to format the full release message
      const formatMessage = () => {
        let message = interpolateMessage(rawMessageTemplate) + '\n\n';

        if (includeLastCommitText && lastCommitBody) {
          message += `*📖 Description:*\n${lastCommitBody}\n\n`;
        }

        if (includeChangelog && nextRelease.notes) {
          message += `*📝 Changelog:*\n${nextRelease.notes}\n\n`;
        }

        return message;
      };

      // 1. Post the initial release message
      const initialMessage = await slackClient.chat.postMessage({
        channel: slackChannel,
        text: formatMessage(),
        mrkdwn: true
      });

      logger.log(`:rocket: Initial release message sent: ${initialMessage.ts}`);

      const threadTs = initialMessage.ts;

      // 2. Upload all files as replies to the initial message
      for (const [filePath, label] of Object.entries(assets)) {
        const resolvedPath = path.resolve(filePath);

        if (fs.existsSync(resolvedPath)) {
          logger.log(`Uploading ${label}...`);

          const fileResponse = await slackClient.files.uploadV2({
            file: fs.createReadStream(resolvedPath),
            filename: path.basename(resolvedPath),
            title: label,
            initial_comment: `📎 ${label}`,
            channel_id: slackChannel,
            thread_ts: threadTs
          });

          if (
            fileResponse.ok &&
            fileResponse.files &&
            fileResponse.files[0] &&
            fileResponse.files[0].files &&
            fileResponse.files[0].files[0]
          ) {
            const uploadedFile = fileResponse.files[0].files[0];
            logger.log(`Uploaded ${label}: ${uploadedFile.id}`);

            downloadLinks.push(`• *${label}*: <${uploadedFile.url_private_download}|Download>`);
          } else {
            logger.error(`Failed to upload ${label}.`);
          }
        } else {
          logger.warn(`File not found: ${resolvedPath}`);
        }
      }

      // 3. Update the message with download links and the lastLine
      if (downloadLinks.length > 0) {
        let updatedMessage = `${formatMessage()}*📥 Download Links:*\n${downloadLinks.join('\n')}`;

        // Append the lastLine if configured
        if (lastLine) {
          updatedMessage += `\n\n${lastLine}`;
        }

        await slackClient.chat.update({
          channel: slackChannel,
          ts: threadTs,
          text: updatedMessage,
          mrkdwn: true
        });

        logger.log('Release message updated with download links and last line.');
      } else {
        logger.warn('No files uploaded. The initial message was not updated.');
      }

    } catch (error) {
      logger.error(`Error during file upload or message update: ${error.message}`);
    }
  }
};
