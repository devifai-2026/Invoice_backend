// controllers/coreControllers/mailController.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const mail = async (req, res) => {
  try {
    const { id } = req.body;
    const entity = 'quote'; // Hardcoded for quote emails

    if (!id) {
      return res.status(400).json({
        success: false,
        result: null,
        message: 'Document ID is required',
      });
    }

    // Get the model
    const Model = mongoose.model(entity.charAt(0).toUpperCase() + entity.slice(1));

    // Find the document with populated client (lead for quotes)
    const document = await Model.findById(id)
      .populate('client')
      .populate('lead') // Quotes use 'lead' instead of 'client'
      .populate('createdBy');

    if (!document) {
      return res.status(404).json({
        success: false,
        result: null,
        message: `${entity} not found`,
      });
    }

    // For quotes, use lead instead of client
    const recipient = document.lead || document.client;

    // If lead/client is not populated, fetch it separately
    if (!recipient || !recipient.email) {
      const Lead = mongoose.model('Lead');
      const lead = await Lead.findById(document.lead || document.client);
      if (lead) {
        document.lead = lead;
      }
    }

    // Check if recipient has email
    if (!document.lead || !document.lead.email) {
      return res.status(400).json({
        success: false,
        result: null,
        message: 'Client/Lead email not found',
      });
    }

    // Get settings for company info
    const Setting = mongoose.model('Setting');
    const settings = await Setting.findOne({});

    // Generate PDF using your existing system
    const pdfBuffer = await generatePDF(entity, document);
    const filename = `${entity}-${document.number || document._id}.pdf`;

    // Create email content
    const emailContent = createEmailTemplate(entity, document, settings);

    // Prepare email options
    const mailOptions = {
      from:
        process.env.EMAIL_FROM ||
        `"${settings?.company_name || 'System'}" <${process.env.EMAIL_USER}>`,
      to: document.lead.email,
      subject: getEmailSubject(entity, document, settings),
      html: emailContent,
      attachments: [
        {
          filename: filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    };

    // Send email
    const transporter = createTransporter();
    const info = await transporter.sendMail(mailOptions);

    console.log(`✅ Quote email sent to ${document.lead.email}: ${info.messageId}`);

    // Update document to track email sent
    document.emailed = true;
    document.emailSentAt = new Date();
    document.emailRecipient = document.lead.email;
    await document.save();

    return res.status(200).json({
      success: true,
      result: {
        messageId: info.messageId,
        recipient: document.lead.email,
        documentId: document._id,
        entity: entity,
        quoteNumber: document.number,
      },
      message: `${entity} #${document.number} sent successfully to ${document.lead.email}`,
    });
  } catch (error) {
    console.error('❌ Email sending error:', error);

    return res.status(500).json({
      success: false,
      result: null,
      message: 'Failed to send email: ' + error.message,
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};

// Create email transporter
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
};

// Generate PDF using your existing system
const generatePDF = async (entity, document) => {
  return new Promise((resolve, reject) => {
    try {
      const custom = require('@/controllers/pdfController');
      const tempDir = path.join(__dirname, '../../temp');

      // Create temp directory if it doesn't exist
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const targetLocation = path.join(tempDir, `${entity}-${document._id}.pdf`);

      // Generate PDF
      custom.generatePdf(
        entity.charAt(0).toUpperCase() + entity.slice(1),
        { filename: entity, format: 'A4', targetLocation },
        document,
        (error) => {
          if (error) {
            console.error('PDF generation callback error:', error);
            reject(new Error('Failed to generate PDF: ' + error.message));
            return;
          }

          try {
            // Check if file exists
            if (!fs.existsSync(targetLocation)) {
              reject(new Error('PDF file was not created at: ' + targetLocation));
              return;
            }

            // Read the generated PDF file
            const pdfBuffer = fs.readFileSync(targetLocation);

            // Verify file size
            if (pdfBuffer.length === 0) {
              reject(new Error('Generated PDF file is empty'));
              return;
            }

            // Clean up temp file
            fs.unlinkSync(targetLocation);

            // Return the PDF buffer
            resolve(pdfBuffer);
          } catch (fileError) {
            console.error('File read error:', fileError);
            reject(new Error('Failed to read PDF file: ' + fileError.message));
          }
        }
      );
    } catch (error) {
      console.error('PDF generation setup error:', error);
      reject(new Error('Failed to setup PDF generation: ' + error.message));
    }
  });
};

// Create email subject
const getEmailSubject = (entity, document, settings) => {
  const entityName = entity.charAt(0).toUpperCase() + entity.slice(1);
  const companyName = settings?.company_name || 'Your Company';

  switch (entity) {
    case 'invoice':
      return `Invoice #${document.number} from ${companyName}`;
    case 'quote':
      // Check if quote is expired
      const isExpired = new Date() > new Date(document.expiredDate);
      const statusText = isExpired ? 'Expired ' : '';
      return `${statusText}Quote #${document.number} from ${companyName}`;
    case 'payment':
      return `Payment Receipt #${document.number} from ${companyName}`;
    default:
      return `${entityName} #${document.number} from ${companyName}`;
  }
};

// Create email HTML template for quotes
const createEmailTemplate = (entity, document, settings) => {
  const entityName = entity.charAt(0).toUpperCase() + entity.slice(1);
  const companyName = settings?.company_name || 'Your Company';
  const companyEmail = settings?.company_email || process.env.EMAIL_USER;
  const companyPhone = settings?.company_phone || '';

  // Check if quote is expired
  const isExpired = new Date() > new Date(document.expiredDate);
  const statusText = isExpired ? 'EXPIRED' : document.status || 'PENDING';
  const statusColor = isExpired
    ? '#ef4444'
    : document.status === 'accepted'
    ? '#10b981'
    : document.status === 'rejected'
    ? '#6b7280'
    : '#f59e0b';

  // Format currency
  const formatCurrency = (amount) => {
    if (!amount) return '₹0.00';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  // Format date
  const formatDate = (date) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${entityName} #${document.number}</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      color: #333;
      margin: 0;
      padding: 0;
      background: #f5f5f5;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background: white;
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .header {
      background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%);
      color: white;
      padding: 30px;
      text-align: center;
      position: relative;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
    }
    .header p {
      margin: 10px 0 0;
      opacity: 0.9;
    }
    .status-badge {
      position: absolute;
      top: 20px;
      right: 20px;
      padding: 6px 15px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      color: white;
      letter-spacing: 0.5px;
    }
    .content {
      padding: 30px;
    }
    .greeting {
      font-size: 18px;
      margin-bottom: 20px;
      color: #2d3748;
    }
    .document-summary {
      background: #f8fafc;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      border-left: 4px solid #4a90e2;
    }
    .summary-table {
      width: 100%;
      border-collapse: collapse;
    }
    .summary-table td {
      padding: 10px;
      border-bottom: 1px solid #e2e8f0;
    }
    .summary-table tr:last-child td {
      border-bottom: none;
    }
    .label {
      color: #64748b;
      font-weight: 500;
    }
    .value {
      text-align: right;
      font-weight: 600;
      color: #1e293b;
    }
    .warning-box {
      background: #fef3c7;
      border: 1px solid #fde68a;
      border-radius: 8px;
      padding: 15px;
      margin: 20px 0;
      color: #92400e;
    }
    .warning-box h3 {
      margin-top: 0;
      color: #92400e;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .warning-box h3::before {
      content: '⚠️';
    }
    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin: 25px 0;
      font-size: 14px;
    }
    .items-table th {
      background: #4a90e2;
      color: white;
      padding: 12px 15px;
      text-align: left;
      font-weight: 600;
    }
    .items-table td {
      padding: 12px 15px;
      border-bottom: 1px solid #e2e8f0;
    }
    .items-table tr:nth-child(even) {
      background: #f8fafc;
    }
    .footer {
      text-align: center;
      padding: 20px;
      color: #64748b;
      font-size: 12px;
      border-top: 1px solid #e2e8f0;
    }
    .company-contact {
      margin: 15px 0;
    }
    .company-contact span {
      margin: 0 10px;
      color: #475569;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%);
      color: white;
      padding: 12px 30px;
      text-decoration: none;
      border-radius: 5px;
      font-weight: 600;
      margin: 20px 0;
    }
    @media (max-width: 600px) {
      .content {
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <div class="status-badge" style="background: ${statusColor};">${statusText}</div>
      <h1>${companyName}</h1>
      <p>${entityName} Proposal</p>
    </div>
    
    <div class="content">
      <div class="greeting">
        Dear ${document.lead?.name || 'Valued Client'},
      </div>
      
      <p>Please find your ${entityName} <strong>#${
    document.number
  }</strong> attached. This proposal outlines the services and pricing we've discussed.</p>
      
      <div class="document-summary">
        <table class="summary-table">
          <tr>
            <td class="label">${entityName} Number:</td>
            <td class="value">#${document.number}</td>
          </tr>
          <tr>
            <td class="label">Date Issued:</td>
            <td class="value">${formatDate(document.date)}</td>
          </tr>
          <tr>
            <td class="label">Valid Until:</td>
            <td class="value">${formatDate(document.expiredDate)}</td>
          </tr>
          <tr>
            <td class="label">Total Amount:</td>
            <td class="value">${formatCurrency(document.total)}</td>
          </tr>
          <tr>
            <td class="label">Prepared For:</td>
            <td class="value">${document.lead?.name || 'Client'}</td>
          </tr>
        </table>
      </div>
      
      ${
        isExpired
          ? `
      <div class="warning-box">
        <h3>This Quote Has Expired</h3>
        <p>This quote expired on ${formatDate(
          document.expiredDate
        )}. Please contact us for an updated quote if you're still interested in our services.</p>
      </div>
      `
          : `
      <div class="warning-box">
        <h3>Quote Expires Soon</h3>
        <p>This quote is valid until ${formatDate(
          document.expiredDate
        )}. Please respond before this date to lock in the quoted pricing.</p>
      </div>
      `
      }
      
      <table class="items-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Unit Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${document.items
            .map(
              (item) => `
          <tr>
            <td>
              <strong>${item.itemName}</strong><br>
              <small style="color: #64748b;">${item.description || ''}</small>
            </td>
            <td>${item.quantity}</td>
            <td>${formatCurrency(item.price)}</td>
            <td>${formatCurrency(item.total)}</td>
          </tr>
          `
            )
            .join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="text-align: right; font-weight: 600;">Subtotal:</td>
            <td style="font-weight: 600;">${formatCurrency(document.subTotal)}</td>
          </tr>
          ${
            document.taxRate > 0
              ? `
          <tr>
            <td colspan="3" style="text-align: right;">Tax (${document.taxRate}%):</td>
            <td>${formatCurrency(document.taxTotal)}</td>
          </tr>
          `
              : ''
          }
          <tr>
            <td colspan="3" style="text-align: right; font-weight: 700; border-top: 2px solid #4a90e2; padding-top: 10px;">Grand Total:</td>
            <td style="font-weight: 700; border-top: 2px solid #4a90e2; padding-top: 10px;">${formatCurrency(
              document.total
            )}</td>
          </tr>
        </tfoot>
      </table>
      
      ${
        document.notes
          ? `
      <div style="background: #f0f9ff; padding: 15px; border-radius: 8px; border-left: 4px solid #0ea5e9; margin: 20px 0;">
        <h4 style="margin-top: 0; color: #0369a1;">📝 Notes</h4>
        <p style="color: #475569; margin: 0;">${document.notes}</p>
      </div>
      `
          : ''
      }
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${process.env.FRONTEND_URL || 'https://your-app.com'}/quote/read/${
    document._id
  }" class="cta-button">
          View & Accept Quote Online
        </a>
      </div>
      
      <p style="color: #64748b; font-size: 14px; text-align: center;">
        This ${entityName} is attached as a PDF file for your records.<br>
        Please review the details and contact us with any questions.
      </p>
    </div>
    
    <div class="footer">
      <div class="company-contact">
        ${companyPhone ? `<span>📞 ${companyPhone}</span>` : ''}
        ${companyEmail ? `<span>✉️ ${companyEmail}</span>` : ''}
      </div>
      <p>This is an automated email from ${companyName}.</p>
      <p>Please do not reply directly to this email.</p>
    </div>
  </div>
</body>
</html>
  `;
};

module.exports = mail;
