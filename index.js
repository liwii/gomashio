const encryptedTokenName = process.env.encryptedTokenName;
const request = require('request');
const rp      = require('request-promise-native');
const AWS     = require('aws-sdk');

let  slackToken = '';

class Config {
  constructor() {
    this.map = new Map;

    let config = require('./config/config.json');
    const topLevelKeyList = ['account_map', 'ignore_event_map', 'repository_map'];
    for (let i = 0, len = topLevelKeyList.length; i < len; i++) {
      this.map.set(topLevelKeyList[i],config[topLevelKeyList[i]] || {});
    }
  }

  set(key, value) {
    this.map.set(key, value);
  }

  get(key) {
    return this.map.get(key);
  }
}

const config = new Config();
const ssm    = new AWS.SSM({apiVersion: '2014-11-06'});

const link = function (url, text) {
  return '<' + url + '|' + text + '>';
};

// slack real name to slack user id
const r2i = function (members) {
  let account_map = {};

  // [NOTE]
  // config.get('account_map') = { 'github account': 'slack real name' }
  // members                   = { 'slack real name': 'slack user id'}
  // => account_map = { 'github account': 'slack user id' }

  Object.keys(config.get('account_map')).forEach(function (key) {
    account_map[key] = members[config.get('account_map')[key]] || config.get('account_map')[key];
  });

  return account_map;
};

// github 2 slack
const g2s = function (user) {
  return config.get('account_map')[user] || user;
};

// repository to channel
const r2c = function(repository) {
  const name = repository['name'];
  let channel = null;

  for ( let rule in config.get('repository_map') ) {
    let re = new RegExp(rule, 'i');
    if (re.test(name)) {
      channel = config.get('repository_map')[rule];
      break;
    }
  }

  return channel;
};

const isIgnoreEvent = function (event, action) {
  const index = (config.get('ignore_event_map')[event] || []).indexOf(action);
  return index !== -1;
};

const userList = function (obj) {
  return obj.map(function(x){
    return '<@' + g2s(x.login) + '>';
  }).join(' ');
};

const replaceUser = function (text) {
  // [NOTE] GitHub Webhook replace space to plus (+) mark.
  // There is no way to distinguish between + in the text and + in the blank.
  return text.replace(/\+/g,' ').replace(/@([a-zA-Z0-9_\-]+)/g, function(match, p1) {
    return '<@' + g2s(p1) + '>';
  });
};

exports.handler = (event, context, callback) => {
  // responce to GitHub
  const responce = {
    statusCode: 200,
    headers: {},
    body: JSON.stringify({ 'message': 'gomashio received' })
  };

  const githubEvent = event.headers['X-GitHub-Event'];
  const payloadText = decodeURIComponent(event.body.replace(/^payload=/,''));
  const payload = JSON.parse(payloadText);
  const action = payload.action || '';
  const repository = payload.repository || {};

  // [NOTE] CloudWatch Logs will display cleanly for text format than json format.
  console.info(githubEvent);
  console.info(payloadText);
  console.info(action);
  console.info(repository);

  if (isIgnoreEvent(githubEvent, action)) {
    console.info('ignore event. nothing to do.');
    context.succeed(responce);
  }

  if (Object.keys(repository).length === 0) {
    console.info('repository is empty. nothing to do.');
    context.succeed(responce);
  }

  const channel = r2c(repository);
  if (channel === null) {
    console.info('repository is not eligible for notification. nothing to do.');
    context.succeed(responce);
  }

  const getParameterPromise = ssm.getParameter({
    Name: encryptedTokenName,
    WithDecryption: true
  }).promise();

  getParameterPromise.then(function(res) {
    slackToken = res.Parameter.Value;

    return rp({
      url: 'https://slack.com/api/users.list',
      method: 'GET',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      json: true,
      qs: {
        token: slackToken
      }
    });
  }).then(function (res) {
    if (res['ok'] === false) {
      throw new Error(res['error']);
    }

    // [NOTE]
    // return an object like { 'Tatsuro Mitsuno': '<slack user id>', }
    const active_members = res['members'].filter(function(member){
      return (member['deleted'] === false && member['is_bot'] === false);
    });

    let name_id_pair = {};
    for(let i = 0; i < active_members.length; i++) {
      name_id_pair[active_members[i]['real_name']] = active_members[i]['id'];
    }
    return name_id_pair;
  }).then(function(members) {
    config.set('account_map', r2i(members));

    let text='';
    switch (githubEvent){
      case 'issue_comment':
      case 'pull_request_review_comment':
        const comment = payload.comment;
        text += comment.user.login + ': \n';
        text += replaceUser(comment.body) + '\n';
        text += comment.html_url;
        break;
      case 'issues':
        const issue = payload.issue;
        if (action == 'assigned') {
          text += 'Issue ' + action + '\n';

          text += 'Assignees: ' + userList(issue.assignees) + '\n';
          text += link(issue.html_url, issue.title);
        }
        break;
      case 'pull_request':
        const pull_request = payload.pull_request;
        if (action == 'assigned') {
          text += 'Pull Request ' + action + '\n';
          text += pull_request.title + '\n';

          text += 'Reviewers: ' + userList(pull_request.requested_reviewers) + '\n';
          text += 'Assignees: ' + userList(pull_request.assignees) + '\n';

          text += link(pull_request.html_url, pull_request.title);
        }
        break;
      default:
        break;
    }

    if (text === '') {
      console.info('text is empty. nothing to do.');
      context.succeed(responce);
    }

    request({
      url: 'https://slack.com/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + slackToken
      },
      json: {
        text: text,
        link_names: 1,
        channel: channel
      }
    }, function () {
      console.info('post to slack.');
      context.succeed(responce);
    });
  }).catch(function (err) {
    console.info(err);
    context.succeed(responce);
  });
};
