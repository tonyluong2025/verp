// Hooks for Changing Menu WebIcon

import fs from "fs/promises";
import { Environment } from "../../core/api"
import { getResourcePath } from "../../core/modules";
import { b64encode } from "../../core/tools";

/**
 * pre init hook
 * @param cr 
 */
export async function testPreInitHook(cr) {
  const env = await Environment.new(cr, global.SUPERUSER_ID);
  const menuItem = await env.items('ir.ui.menu').search([['parentId', '=', false]]);

  for (const menu of menuItem) {
    const label = await menu.label;
    if (label == 'Contacts') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Contacts.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Link Tracker') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Link Tracker.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Dashboards') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Dashboards.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Sales') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Sales.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Invoicing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Invoicing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Inventory') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Inventory.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Purchase') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Purchase.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Calendar') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Calendar.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'CRM') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'CRM.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Note') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Note.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Website') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Website.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Point of Sale') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Point of Sale.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Manufacturing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Manufacturing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Repairs') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Repairs.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Email Marketing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Email Marketing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'SMS Marketing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'SMS Marketing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Project') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Project.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Surveys') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Surveys.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Employees') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Employees.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Recruitment') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Recruitment.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Attendances') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Attendances.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Time Off') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Time Off.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Expenses') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Expenses.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Maintenance') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Maintenance.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Live Chat') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Live Chat.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Lunch') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Lunch.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Fleet') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Fleet.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Timesheets') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Timesheets.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Events') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Events.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'eLearning') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'eLearning.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Members') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Members.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
  }
}

/**
 * post init hook
 */
export async function testPostInitHook(cr, registry) {

  const env = await Environment.new(cr, global.SUPERUSER_ID);
  const menuItem = await env.items('ir.ui.menu').search([['parentId', '=', false]]);

  for (const menu of menuItem) {
    const label = await menu.label;
    if (label == 'Contacts') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Contacts.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Link Tracker') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Link Tracker.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Dashboards') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Dashboards.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Sales') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Sales.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Invoicing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Invoicing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Inventory') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Inventory.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Purchase') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Purchase.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Calendar') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Calendar.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'CRM') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'CRM.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Note') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Note.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Website') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Website.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Point of Sale') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Point of Sale.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Manufacturing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Manufacturing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Repairs') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Repairs.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Email Marketing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Email Marketing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'SMS Marketing') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'SMS Marketing.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Project') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Project.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Surveys') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Surveys.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Employees') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Employees.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Recruitment') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Recruitment.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Attendances') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Attendances.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Time Off') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Time Off.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Expenses') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Expenses.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Maintenance') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Maintenance.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Live Chat') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Live Chat.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Lunch') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Lunch.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Fleet') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Fleet.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Timesheets') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Timesheets.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Events') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Events.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'eLearning') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'eLearning.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
    if (label == 'Members') {
      const imgPath = getResourcePath(
        'backend_code_theme', 'static', 'src', 'img', 'icons', 'Members.png')
      await menu.write({ 'webIconData': b64encode(await fs.readFile(imgPath)) })
    }
  }
}