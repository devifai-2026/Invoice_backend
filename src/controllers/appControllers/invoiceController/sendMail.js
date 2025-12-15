// controllers/coreControllers/mailController.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const mail = async (req, res) => {
  try {
    const { id } = req.body;
    const entity = 'invoice'; // Hardcode since this is only for invoices

    if (!id) {
      return res.status(400).json({
        success: false,
        result: null,
        message: 'Document ID is required',
      });
    }

    // Get the model
    const Model = mongoose.model(entity.charAt(0).toUpperCase() + entity.slice(1));

    // Find the document with populated client
    const document = await Model.findById(id).populate('client').populate('createdBy');

    if (!document) {
      return res.status(404).json({
        success: false,
        result: null,
        message: `${entity} not found`,
      });
    }

    // If client is not populated, fetch it separately
    if (!document.client || !document.client.email) {
      const Client = mongoose.model('Client');
      const client = await Client.findById(document.client);
      document.client = client;
    }

    // Check if client has email
    if (!document.client || !document.client.email) {
      return res.status(400).json({
        success: false,
        result: null,
        message: 'Client email not found',
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
      to: document.client.email,
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

    console.log(`✅ Email sent to ${document.client.email}: ${info.messageId}`);

    // Update document to track email sent
    document.emailed = true;
    document.emailSentAt = new Date();
    document.emailRecipient = document.client.email;
    await document.save();

    return res.status(200).json({
      success: true,
      result: {
        messageId: info.messageId,
        recipient: document.client.email,
        documentId: document._id,
        entity: entity,
        invoiceNumber: document.number,
      },
      message: `${entity} #${document.number} sent successfully to ${document.client.email}`,
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

// Generate PDF using your existing system - FIXED VERSION
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
  const companyName = settings?.company_name || 'Devifai';

  switch (entity) {
    case 'invoice':
      return `Invoice #${document.number} from ${companyName}`;
    case 'quote':
      return `Quote #${document.number} from ${companyName}`;
    case 'payment':
      return `Payment Receipt #${document.number} from ${companyName}`;
    default:
      return `${entityName} #${document.number} from ${companyName}`;
  }
};

// Create email HTML template
const createEmailTemplate = (entity, document, settings) => {
  const entityName = entity.charAt(0).toUpperCase() + entity.slice(1);
  const companyName = settings?.company_name || 'Devifai Software Development';
  const companyEmail = settings?.company_email || process.env.EMAIL_USER;
  const companyPhone = settings?.company_phone || '91 8777468277';

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

  // Get status badge color
  const getStatusColor = (status) => {
    switch (status) {
      case 'paid':
        return '#10b981';
      case 'partially':
        return '#3b82f6';
      case 'pending':
        return '#f59e0b';
      case 'overdue':
        return '#ef4444';
      default:
        return '#6b7280';
    }
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
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
    }
    .header p {
      margin: 10px 0 0;
      opacity: 0.9;
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
      border-left: 4px solid #667eea;
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
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      color: white;
    }
    .payment-info {
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      border-radius: 8px;
      padding: 20px;
      margin: 25px 0;
    }
    .payment-info h3 {
      color: #0369a1;
      margin-top: 0;
    }
    .payment-details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-top: 15px;
    }
    .payment-item {
      background: white;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #e2e8f0;
    }
    .payment-label {
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .payment-value {
      font-size: 14px;
      font-weight: 600;
      color: #1e293b;
      word-break: break-all;
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
    @media (max-width: 600px) {
      .content {
        padding: 20px;
      }
      .payment-details {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <h1>${companyName}</h1>
      <p>${entityName} Notification</p>
    </div>
    
    <div class="content">
      <div class="greeting">
        Dear ${document.client?.name || 'Valued Customer'},
      </div>
      
      <p>Your ${entityName} <strong>#${
    document.number
  }</strong> has been generated and is attached to this email.</p>
      
      <div class="document-summary">
        <table class="summary-table">
          <tr>
            <td class="label">${entityName} Number:</td>
            <td class="value">#${document.number}</td>
          </tr>
          <tr>
            <td class="label">Date:</td>
            <td class="value">${formatDate(document.date)}</td>
          </tr>
          ${
            document.expiredDate
              ? `
          <tr>
            <td class="label">Due Date:</td>
            <td class="value">${formatDate(document.expiredDate)}</td>
          </tr>
          `
              : ''
          }
          <tr>
            <td class="label">Total Amount:</td>
            <td class="value">${formatCurrency(document.total)}</td>
          </tr>
          ${
            document.paymentStatus
              ? `
          <tr>
            <td class="label">Status:</td>
            <td class="value">
              <span class="status-badge" style="background: ${getStatusColor(
                document.paymentStatus
              )};">
                ${document.paymentStatus}
              </span>
            </td>
          </tr>
          `
              : ''
          }
          ${
            document.credit > 0
              ? `
          <tr>
            <td class="label">Amount Paid:</td>
            <td class="value" style="color: #10b981;">${formatCurrency(document.credit)}</td>
          </tr>
          <tr>
            <td class="label">Balance Due:</td>
            <td class="value" style="color: #ef4444;">${formatCurrency(
              document.total - document.credit
            )}</td>
          </tr>
          `
              : ''
          }
        </table>
      </div>
      
      ${
        entity === 'invoice'
          ? `
      <div class="payment-info">
        <h3>💳 Payment Instructions</h3>
        <div class="payment-details">
          <div class="payment-item">
            <div class="payment-label">UPI ID</div>
            <div class="payment-value">8777468277@mbkns</div>
          </div>
          <div class="payment-item">
            <div class="payment-label">Bank Account</div>
            <div class="payment-value">924010025759736</div>
          </div>
          <div class="payment-item">
            <div class="payment-label">IFSC Code</div>
            <div class="payment-value">UTIB0004771</div>
          </div>
          <div class="payment-item">
            <div class="payment-label">Account Holder</div>
            <div class="payment-value">Subhojit Dutta</div>
          </div>
        </div>
        
      </div>
      `
          : ''
      }
      
      <p style="color: #64748b; font-size: 14px;">
        This ${entityName} is attached as a PDF file. If you have any questions or need further assistance, 
        please don't hesitate to contact us.
      </p>
    </div>
    
    <div class="footer">
      <div class="company-contact">
        ${companyPhone ? `<span>📞 ${companyPhone}</span>` : ''}
        ${companyEmail ? `<span>✉️ ${companyEmail}</span>` : ''}
      </div>
      <p>This is an automated email from ${companyName}.</p>
      <p>Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>
  `;
};

module.exports = mail;
