const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const fastGlob = require('fast-glob'); // Import glob library

module.exports = {
  async success(pluginConfig, context) {
    const { nextRelease, commits, branch, logger } = context;
    const slackToken = process.env.SLACK_TOKEN;
    const slackChannel = process.env.SLACK_CHANNEL;

    if (!slackToken || !slackChannel) {
      throw new Error('SLACK_TOKEN or SLACK_CHANNEL is not set in the environment variables.');
    }

    const slackClient = new WebClient(slackToken);
    const rawAssets = pluginConfig.assets || {};
    const isPrerelease = branch.prerelease || false;
    const prereleaseConfig = pluginConfig.prerelease || {};
    const prereleaseEnabled = prereleaseConfig.enabled ?? false;
    const includeChangelog = isPrerelease ? prereleaseConfig.changelog ?? false : pluginConfig.changelog ?? false;
    const includeLastCommitText = isPrerelease ? prereleaseConfig.lastCommitText ?? false : pluginConfig.lastCommitText ?? false;
    const lastLine = isPrerelease ? prereleaseConfig.lastLine || '' : pluginConfig.lastLine || '';
    const rawMessageTemplate = isPrerelease ? prereleaseConfig.message || `Prerelease: ${nextRelease.version}` : pluginConfig.message || `New release: ${nextRelease.version}`;

    // if prerelease.enabled is false and the branch is a prerelease, skip the release
    if (!prereleaseEnabled && isPrerelease) {
      logger.log(`Skipping release for prerelease branch: ${branch.name}`);
      return;
    }

    let downloadLinks = [];
    let initialMessage;
    let threadTs;

    // Helper function to replace placeholders
    const interpolateString = (template) => {
      return template
        .replace(/\$\{nextRelease\.version\}/g, nextRelease.version || '')
        .replace(/\$\{nextRelease\.notes\}/g, nextRelease.notes || '');
    };

    // Resolve assets using glob patterns and interpolate placeholders
    const resolveAssets = async () => {
      const resolvedAssets = {};
      const missingAssets = [];
      for (const [rawPath, label] of Object.entries(rawAssets)) {
        const interpolatedPath = interpolateString(rawPath);
        const matchedFiles = await fastGlob(interpolatedPath);

        if (matchedFiles.length === 0) {
          missingAssets.push(interpolatedPath);
        } else {
          for (const file of matchedFiles) {
            resolvedAssets[file] = label;
          }
        }
      }

      if (missingAssets.length > 0) {
        throw new Error(`The following required assets were not found:\n${missingAssets.join('\n')}`);
      }

      return resolvedAssets;
    };

    try {
      // Resolve assets
      const assets = await resolveAssets();

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
        let message = interpolateString(rawMessageTemplate) + '\n\n';

        if (includeLastCommitText && lastCommitBody) {
          message += `*📖 Description:*\n${lastCommitBody}\n\n`;
        }

        if (includeChangelog && nextRelease.notes) {
          message += `*📝 Changelog:*\n${nextRelease.notes}\n\n`;
        }

        return message;
      };

      // 1. Post the initial release message
      initialMessage = await slackClient.chat.postMessage({
        channel: slackChannel,
        text: formatMessage(),
        mrkdwn: true
      });

      logger.log(`:rocket: Initial release message sent: ${initialMessage.ts}`);
      threadTs = initialMessage.ts;

      // 2. Upload all resolved files as replies to the initial message
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
          throw new Error(`Resolved file not found: ${resolvedPath}`);
        }
      }

      // 3. Update the message with download links and the lastLine
      if (downloadLinks.length > 0) {
        let updatedMessage = `${formatMessage()}*📥 Download Links:*\n${downloadLinks.join('\n')}`;

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

      // Post error in the thread
      if (threadTs) {
        await slackClient.chat.postMessage({
          channel: slackChannel,
          thread_ts: threadTs,
          text: `:x: An error occurred during the release process:\n\`${error.message}\``,
          mrkdwn: true
        });
      }

      // Add prominent error note to the original announcement message
      if (initialMessage) {
        const updatedMessageWithError = `${initialMessage.message.text}\n\n:x: *An issue occurred with this release. Users are advised NOT to use this version.*`;
        await slackClient.chat.update({
          channel: slackChannel,
          ts: initialMessage.ts,
          text: updatedMessageWithError,
          mrkdwn: true
        });
      }

      throw error; // Rethrow the error to fail the semantic-release pipeline
    }
  }
};
