import controller from './controller'

import yaml from 'js-yaml'
import fs from 'fs'
import path from 'path'
import { sample, merge } from 'lodash'
import Airtable from 'airtable'
const bases = {}
bases.operations = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base(
  process.env.AIRTABLE_OPERATIONS_BASE
)
bases.hackaf = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base(
  process.env.AIRTABLE_HACKAF_BASE
)
bases.sdp = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base(
  process.env.AIRTABLE_SDP_BASE
)

export const airPatch = (baseName, recordID, values, options = {}) =>
  new Promise((resolve, reject) => {
    const timestamp = Date.now()
    console.log(
      `I'm asking Airtable to patch ${recordID} record in ${baseName} base at ${timestamp} with the new values: ${JSON.stringify(
        values
      )}`
    )
    const base = bases[options.base || 'operations']
    base(baseName).update(recordID, values, (err, record) => {
      if (err) {
        console.error(err)
        reject(err)
      }
      console.log(
        `Airtable updated my ${baseName} record from ${timestamp} in ${Date.now() -
          timestamp}ms`
      )
      resolve(record)
    })
  })

export const airCreate = (baseName, fields, options = {}) =>
  new Promise((resolve, reject) => {
    const timestamp = Date.now()
    console.log(
      `I'm asking Airtable to create a new record in the ${baseName} base at ${timestamp}`
    )
    const base = bases[options.base || 'operations']
    base(baseName).create(fields, (err, record) => {
      if (err) {
        console.error(err)
        reject(err)
      }
      if (!record) {
        reject(new Error('Record not created'))
      }
      console.log(
        `Airtable saved my ${baseName} record from ${timestamp} in ${Date.now() -
          timestamp}ms`
      )
      resolve(record)
    })
  })

export const airFind = (baseName, fieldName, value, options = {}) =>
  new Promise((resolve, reject) => {
    // see airGet() for usage
    airGet(baseName, fieldName, value, options)
      .then(results => resolve(results[0]))
      .catch(err => reject(err))
  })

export const airGet = (
  baseName,
  searchArg = null,
  tertiaryArg = null,
  options = {}
) =>
  new Promise((resolve, reject) => {
    // usage:
    // for key/value lookup: `airGet('Clubs', 'Slack Channel ID', slackChannelID)`
    // for formula lookup: `airGet('Clubs', '{Slack Channel ID} = BLANK()')`
    // for all records: `airGet('Leaders')`

    const timestamp = Date.now()

    const selectBy = {}
    if (searchArg === null) {
      console.log(
        `I'm asking AirTable to send me ALL records in the "${baseName}" base. The timestamp is ${timestamp}`
      )
    } else {
      if (tertiaryArg) {
        // this is a key/value lookup
        selectBy.filterByFormula = `{${searchArg}} = "${tertiaryArg}"`
      } else {
        // this is a formula lookup
        selectBy.filterByFormula = searchArg
      }

      console.log(
        `I wrote a query & sent it to AirTable with a timestamp of ${timestamp}: BASE=\`${baseName}\` FILTER=\`${selectBy.filterByFormula}\``
      )
    }

    const base = bases[options.base || 'operations']
    base(baseName)
      .select(selectBy)
      .all((err, data) => {
        if (err) {
          console.error(err)
          reject(err)
        }
        console.log(
          `AirTable got back to me from my question at ${timestamp} with ${
            data.length
          } records. The query took ${Date.now() - timestamp}ms`
        )
        resolve(data)
      })
  })

export const getSlackUser = user =>
  new Promise((resolve, reject) => {
    initBot().api.users.info({ user, include_locale: true }, (err, res) => {
      if (err) {
        reject(err)
      }
      resolve(res.user)
    })
  })

export const getInfoForUser = user =>
  new Promise((resolve, reject) => {
    const results = {}

    const timestamp = Date.now()
    console.log(`Getting info for user '${user}' at timestamp ${timestamp}`)

    Promise.all([
      getSlackUser(user).then(slackUser => (results.slackUser = slackUser)),
      userRecord(user).then(userRecord => (results.userRecord = userRecord)),
      // Get the leader from the user
      airFind('Leaders', 'Slack ID', user)
        .then(leader => (results.leader = leader))
        // Then club from leader
        .then(() => {
          if (!results.leader) return null

          return airFind(
            'Clubs',
            `FIND("${results.leader.fields.ID}", Leaders)`
          )
        })
        .then(club => (results.club = club))
        // Then club's history from club
        .then(() => {
          if (!results.club) return null

          return airGet('History', 'Club', results.club.fields.ID)
        })
        .then(history => (results.rawHistory = history)),
    ])
      .then(() =>
        Promise.all([
          new Promise(resolve => {
            if (!results.rawHistory) resolve(null)

            results.history = {
              lastMeetingDay: 'monday',
              records: results.rawHistory,
              meetings: results.rawHistory
                .filter(h => h.fields.Attendance)
                .filter(h => !h.fields['Deleted At'])
                .sort(
                  (a, b) =>
                    Date.parse(a.fields.Date) - Date.parse(b.fields.Date)
                ),
            }

            if (results.history.meetings.length > 0) {
              const lastMeetingDay = new Date(
                results.history.meetings[0].fields.Date
              ).toLocaleDateString('en-us', {
                weekday: 'long',
                timeZone: results.slackUser.tz,
              })
              results.history.lastMeetingDay = lastMeetingDay
            }
            resolve()
          }),
          new Promise((resolve, reject) => {
            if (results.leader && results.leader.fields['Address']) {
              airFind(
                'Addresses',
                `'${results.leader.fields['Address']}' = RECORD_ID()`
              )
                .then(leaderAddress => (results.leaderAddress = leaderAddress))
                .then(resolve)
                .catch(reject)
            } else {
              resolve()
            }
          }),
          new Promise((resolve, reject) => {
            if (results.club && results.club.fields['Address']) {
              airFind(
                'Addresses',
                `'${results.club.fields['Address']}' = RECORD_ID()`
              )
                .then(clubAddress => (results.clubAddress = clubAddress))
                .then(resolve)
                .catch(reject)
            } else {
              resolve()
            }
          }),
        ])
      )
      .then(() => {
        console.log(
          `Finished pulling up the info about user '${user}' from ${timestamp} in ${Date.now() -
            timestamp}ms`
        )
        resolve(results)
      })
      .catch(e => reject(e))
  })

export const recordMeeting = (club, meeting, cb) => {
  bases.operations('History').create(
    {
      Type: ['Meeting'],
      Club: [club.id],
      Date: meeting.date,
      Attendance: meeting.attendance,
      Notes: `@orpheus-bot created this entry from a Slack checkin`,
    },
    (err, record) => {
      if (err) {
        console.error(err)
      }
      cb(err, record)
    }
  )
}

const buildUserRecord = r => ({
  ...r,
  fields: JSON.parse(r.fields['Data'] || '{}'),
  patch: updatedFields =>
    new Promise((resolve, reject) => {
      const oldFields = buildUserRecord(r).fields
      getSlackUser(r.fields['User'])
        .then(slackUser => {
          const newFields = {
            Username: '@' + slackUser.name,
            Data: JSON.stringify(
              merge(oldFields, updatedFields),
              null,
              2 // https://stackoverflow.com/a/7220510
            ),
          }
          return airPatch('Orpheus', r.id, newFields).then(newRecord =>
            resolve(buildUserRecord(newRecord))
          )
        })
        .catch(err => {
          reject(err)
        })
    }),
})

export const userRecord = user =>
  new Promise((resolve, reject) => {
    console.log(`I'm looking up an airRecord for "${user}"`)
    airFind('Orpheus', 'User', user)
      .then(record => {
        if (record) {
          console.log(`I found an airRecord for "${user}"`)
          // if it already exists, return it
          resolve(buildUserRecord(record))
        } else {
          console.log(
            `I didn't find an airRecord for "${user}", so I'm creating a new one`
          )
          // if it doesn't exist, create one...
          getSlackUser(user)
            .then(slackUser =>
              bases.operations('Orpheus').create(
                {
                  Username: '@' + slackUser.name,
                  User: user,
                  Data: '{}',
                },
                (err, record) => {
                  if (err) {
                    throw err
                  }
                  console.log(`I created a new airRecord for "${user}"`)
                  // ... & return it
                  resolve(buildUserRecord(record))
                }
              )
            )
            .catch(err => {
              throw err
            })
        }
      })
      .catch(err => reject(err))
  })

export const initBot = (admin = false) =>
  // we need to create our "bot" context for interactions that aren't initiated by the user.
  // ex. we want to send a "hello world" message on startup w/o waiting for a user to trigger it.

  // (max@maxwofford.com) Warning about admin tokens: this runs with my
  // workspace token. Whatever is done with this token will look like I did it
  // (ex. "@msw has renamed this channel")
  controller.spawn({
    token: admin ? process.env.SLACK_LEGACY_TOKEN : process.env.SLACK_BOT_TOKEN,
  })

const loadTranscript = () => {
  try {
    const doc = yaml.safeLoad(
      fs.readFileSync(path.resolve(__dirname, './transcript.yml'), 'utf8')
    )
    return doc
  } catch (e) {
    console.error(e)
  }
}
const recurseTranscript = (searchArr, transcriptObj) => {
  const searchCursor = searchArr.shift()
  const targetObj = transcriptObj[searchCursor]

  if (searchArr.length > 0) {
    return recurseTranscript(searchArr, targetObj)
  } else {
    if (Array.isArray(targetObj)) {
      return sample(targetObj)
    } else {
      return targetObj
    }
  }
}
const replaceErrors = (key, value) => {
  // from https://stackoverflow.com/a/18391400
  if (value instanceof Error) {
    const error = {}
    Object.getOwnPropertyNames(value).forEach(key => {
      error[key] = value[key]
    })
    return error
  }
  return value
}
export const transcript = (search, vars) => {
  if (vars) {
    console.log(
      `I'm searching for words in my yaml file under "${search}". These variables are set: ${JSON.stringify(
        vars,
        replaceErrors
      )}`
    )
  } else {
    console.log(`I'm searching for words in my yaml file under "${search}"`)
  }
  const searchArr = search.split('.')
  const transcriptObj = loadTranscript()

  return evalTranscript(recurseTranscript(searchArr, transcriptObj), vars)
}
const evalTranscript = (target, vars = {}) =>
  function() {
    return eval('`' + target + '`')
  }.call({
    ...vars,
    t: transcript,
  })
