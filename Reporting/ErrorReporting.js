"use strict";

const nodemailer = require("nodemailer");
const fs = require("fs");
const handlebars = require("handlebars");

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
    },
});

// async..await is not allowed in global scope, must use a wrapper
async function sendEmail(
    emailList,
    templateData,
    subject,
    templatePath,
    fromMail,
    fromName
) {
    try {
        const source = fs.readFileSync(templatePath, { encoding: "utf-8" });
        const template = handlebars.compile(source);
        const html = template(templateData);

        // send mail with defined transport object
        const info = await transporter.sendMail({
            from: `${fromName} ${fromMail}@picolon.com`, // sender address
            to: emailList, // list of receivers
            subject: subject, // Subject line
            html: html,
        });

        transporter.sendMail(info, function (err) {
            if (err) {
                console.error(err.message);
            }
        });
    } catch (error) {
        console.error(error.message);
    }
}

module.exports = sendEmail;
